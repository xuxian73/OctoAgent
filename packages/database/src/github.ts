import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { LocalGitProvider } from "../../delivery/src/local-git.js";
import { RepositoryState } from "../../delivery/src/github.js";
import {
  GitHubRest,
  GitHubProfile,
  RemoteScope,
  loadGitHubProfiles,
  profileDigest,
  gitHash,
  remoteFail
} from "../../delivery/src/github-rest.js";
import { Contracts } from "./contracts.js";
import { Audit } from "./security.js";
interface Plan {
  branch: string;
  localSha: string;
  remoteSha: string;
  baseSha: string;
  tree: string;
  message: string;
  version: number;
}
export class GitHubConnections {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private local = new LocalGitProvider(),
    private profiles = loadGitHubProfiles,
    private rest = new GitHubRest(),
    private now = Date.now
  ) {}
  private access(token: string, id: string, write = false) {
    const contract = new Contracts(this.db, this.auth, this.now).read(
      token,
      id
    );
    const access = this.auth.authorize(
      token,
      { kind: "contract", resourceId: id, action: write ? "write" : "read" },
      ["buyer", "seller"]
    );
    return { contract, access };
  }
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM github_connections WHERE contract_id=?")
      .get(id);
  }
  private profile(id: string, profileId: unknown, buyer: unknown) {
    const p = this.profiles().find(
      p =>
        p.id === profileId &&
        p.contractId === id &&
        p.responsibleUserId === buyer
    );
    if (!p || p.expiresAt <= this.now()) throw new ForbiddenError();
    return p;
  }
  read(token: string, id: string) {
    const { contract, access } = this.access(token, id);
    const row = this.row(id);
    const profiles = this.profiles().filter(
      p =>
        p.contractId === id &&
        p.responsibleUserId === contract.buyer_id &&
        p.expiresAt > this.now()
    );
    const p = profiles.find(p => p.id === row?.profile_id);
    const connected =
      !!row &&
      !row.revoked &&
      Number(row.expires_at) > this.now() &&
      row.version === contract.version &&
      !!p &&
      profileDigest(p) === row.profile_digest;
    return {
      mode: connected ? "github-connected" : "local-git",
      nextStep: connected
        ? "按独立权限同步、创建 PR 或读取远端检查；不合并、不部署"
        : "本地 Git 可继续交付；请部署者配置仓库，再由甲方责任主体确认连接",
      profiles:
        access.role === "buyer"
          ? profiles.map(p => ({
              id: p.id,
              repository: `${p.owner}/${p.repo}`,
              repositoryId: p.repositoryId,
              base: p.base,
              allowed: p.allowed,
              expiresAt: p.expiresAt
            }))
          : [],
      connection: row
        ? {
            id: row.id,
            repository: p ? `${p.owner}/${p.repo}` : null,
            scopes: JSON.parse(String(row.scopes)),
            expiresAt: row.expires_at,
            active: connected
          }
        : null,
      evidence: row
        ? this.db
            .prepare(
              "SELECT evidence FROM github_deliveries WHERE connection_id=? AND evidence IS NOT NULL"
            )
            .all(row.id!)
            .map(r => JSON.parse(String(r.evidence)))
        : []
    };
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private record(
    id: string,
    version: number,
    actor: string,
    action: string,
    evidence: unknown
  ) {
    this.db
      .prepare(
        "INSERT INTO contract_events(contract_id,version,actor_id,created_at,kind,payload) VALUES (?,?,?,?,?,?)"
      )
      .run(
        id,
        version,
        actor,
        this.now(),
        "workspace_github_" + action,
        JSON.stringify(evidence)
      );
    new Audit(this.db).append(`GitHub.${action}`, "success", {
      type: "contract",
      id
    });
  }
  private state(id: string) {
    const row = this.db
      .prepare("SELECT state FROM delivery_workspaces WHERE contract_id=?")
      .get(id);
    if (!row) throw new ForbiddenError();
    return JSON.parse(String(row.state)) as RepositoryState;
  }
  async command(token: string, id: string, input: Record<string, unknown>) {
    let lease: string | undefined;
    const action = input.action;
    try {
      const { contract, access } = this.access(token, id, action !== "checks");
      if (input.version !== contract.version) remoteFail("STALE_CONTRACT");
      if (
        action === "prepare_connect" ||
        action === "connect" ||
        action === "revoke"
      ) {
        if (
          access.identity.kind !== "user" ||
          access.role !== "buyer" ||
          access.identity.id !== contract.buyer_id ||
          (action !== "prepare_connect" && input.confirmed !== true)
        )
          throw new ForbiddenError();
        const result = this.atomic(() => {
          if (action === "revoke") {
            this.db
              .prepare(
                "UPDATE github_connections SET revoked=1 WHERE contract_id=?"
              )
              .run(id);
          } else {
            if (contract.status !== "active") remoteFail("CONTRACT_NOT_ACTIVE");
            const p = this.profile(id, input.profileId, contract.buyer_id);
            const scopes = input.scopes === undefined ? ["read"] : input.scopes;
            if (
              !Array.isArray(scopes) ||
              !scopes.includes("read") ||
              scopes.some(s => !p.allowed.includes(s as RemoteScope))
            )
              throw new ForbiddenError();
            const ttl = input.ttlMs;
            if (
              typeof ttl !== "number" ||
              !Number.isSafeInteger(ttl) ||
              ttl <= 0 ||
              ttl > 900000
            )
              remoteFail("INVALID_TTL");
            const binding = JSON.stringify({
              profile: profileDigest(p),
              version: contract.version,
              actor: access.identity.id,
              scopes: [...new Set(scopes)].sort(),
              ttl
            });
            if (action === "prepare_connect") {
              const confirmationId = randomUUID();
              const expiresAt = Math.min(this.now() + ttl, p.expiresAt);
              this.db
                .prepare(
                  "INSERT INTO github_confirmations(id,contract_id,binding,expires_at) VALUES (?,?,?,?)"
                )
                .run(confirmationId, id, binding, expiresAt);
              return {
                confirmationId,
                repository: `${p.owner}/${p.repo}`,
                repositoryId: p.repositoryId,
                base: p.base,
                version: contract.version,
                scopes,
                expiresAt
              };
            }
            const confirmation = this.db
              .prepare(
                "SELECT * FROM github_confirmations WHERE id=? AND contract_id=?"
              )
              .get(
                typeof input.confirmationId === "string"
                  ? input.confirmationId
                  : "",
                id
              );
            if (
              !confirmation ||
              confirmation.invalidated ||
              confirmation.binding !== binding ||
              Number(confirmation.expires_at) <= this.now()
            )
              remoteFail("GITHUB_CONFIRMATION_INVALID");
            const old = this.row(id);
            // Scope increases/reconnections are new explicit confirmations, never an extension of a read credential.
            if (old && Number(old.lease_until) > this.now())
              remoteFail("GITHUB_BUSY");
            this.db
              .prepare(
                `INSERT INTO github_connections(contract_id,id,profile_id,profile_digest,version,actor_id,scopes,expires_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(contract_id) DO UPDATE SET id=excluded.id,profile_id=excluded.profile_id,profile_digest=excluded.profile_digest,version=excluded.version,actor_id=excluded.actor_id,scopes=excluded.scopes,expires_at=excluded.expires_at,revoked=0,lease=NULL,lease_until=0`
              )
              .run(
                id,
                old?.profile_digest === profileDigest(p) &&
                  old.version === contract.version
                  ? String(old.id)
                  : randomUUID(),
                p.id,
                profileDigest(p),
                contract.version,
                access.identity.id,
                JSON.stringify([...new Set(scopes)]),
                Number(confirmation.expires_at)
              );
          }
          // Consuming, revoking or replacing a connection invalidates every
          // outstanding confirmation, including delayed requests from other tabs.
          this.db
            .prepare(
              "UPDATE github_confirmations SET invalidated=1 WHERE contract_id=?"
            )
            .run(id);
          const saved = this.row(id);
          if (saved)
            this.record(id, contract.version, access.identity.id, action, {
              connectionId: saved.id,
              scopes: JSON.parse(String(saved.scopes)),
              expiresAt: saved.expires_at,
              revoked: Boolean(saved.revoked)
            });
        });
        return result || this.read(token, id);
      }
      const scope: RemoteScope =
        action === "sync"
          ? "write"
          : action === "create_pr"
          ? "create_pr"
          : action === "checks"
          ? "read"
          : remoteFail("GITHUB_ACTION_DISABLED");
      const row = this.row(id);
      if (!row) throw new ForbiddenError();
      const p = this.profile(id, row.profile_id, contract.buyer_id);
      const connectionId = String(row.id);
      const assertAuthorized = () => {
        const current = this.access(token, id, scope !== "read");
        const r = this.row(id);
        if (
          current.contract.status !== "active" ||
          current.contract.version !== row.version ||
          !r ||
          r.id !== connectionId ||
          r.revoked ||
          Number(r.expires_at) <= this.now() ||
          profileDigest(
            this.profile(id, r.profile_id, current.contract.buyer_id)
          ) !== r.profile_digest ||
          !JSON.parse(String(r.scopes)).includes(scope) ||
          (lease && r.lease !== lease)
        )
          throw new ForbiddenError();
        if (scope !== "read") {
          if (current.access.role !== "seller") throw new ForbiddenError();
          const required =
            scope === "write" ? ["branch", "commit"] : ["pull_request"];
          for (const permission of required) {
            const grant = this.db
              .prepare(
                "SELECT 1 FROM delivery_permissions WHERE contract_id=? AND actor_id=? AND permission=? AND expires_at>?"
              )
              .get(id, current.access.identity.id, permission, this.now());
            if (!grant) throw new ForbiddenError();
          }
        }
        if (lease)
          this.db
            .prepare(
              "UPDATE github_connections SET lease_until=? WHERE contract_id=? AND lease=?"
            )
            .run(this.now() + 30000, id, lease);
      };
      assertAuthorized();
      lease = randomUUID();
      if (
        !this.db
          .prepare(
            "UPDATE github_connections SET lease=?,lease_until=? WHERE contract_id=? AND lease_until<=?"
          )
          .run(lease, this.now() + 30000, id, this.now()).changes
      ) {
        lease = undefined;
        remoteFail("GITHUB_BUSY");
      }
      const localSha = input.sha;
      const state = this.state(id);
      const commit = state.commits.find(
        c =>
          c.sha === localSha &&
          c.version === contract.version &&
          state.branches[c.branch] === c.sha
      );
      if (!commit) remoteFail("COMMIT_REQUIRED");
      const snapshot = this.local.snapshot(state, id, commit.sha);
      await this.rest.repository(p, assertAuthorized);
      let saved = this.db
        .prepare(
          "SELECT * FROM github_deliveries WHERE connection_id=? AND local_sha=?"
        )
        .get(connectionId, commit.sha);
      let plan: Plan;
      if (!saved) {
        if (action !== "sync") remoteFail("GITHUB_SYNC_REQUIRED");
        const baseSha = (await this.rest.ref(p, p.base, assertAuthorized))!;
        const branch = `octo-${createHash("sha256")
          .update(id)
          .digest("hex")
          .slice(0, 16)}-${commit.sha}`;
        const message = `OctoAgent snapshot ${commit.sha}\n`;
        const raw = `tree ${snapshot.tree}\nparent ${baseSha}\nauthor OctoAgent <local@invalid> 946684800 +0000\ncommitter OctoAgent <local@invalid> 946684800 +0000\n\n${message}`;
        plan = {
          branch,
          localSha: commit.sha,
          remoteSha: gitHash("commit", raw),
          baseSha,
          tree: snapshot.tree,
          message,
          version: contract.version
        };
        assertAuthorized();
        this.db
          .prepare(
            "INSERT INTO github_deliveries(connection_id,local_sha,plan) VALUES (?,?,?)"
          )
          .run(connectionId, commit.sha, JSON.stringify(plan));
      } else plan = JSON.parse(String(saved.plan));
      if (plan.tree !== snapshot.tree) remoteFail();
      if (action === "sync" || action === "create_pr") {
        if ((await this.rest.ref(p, p.base, assertAuthorized)) !== plan.baseSha)
          remoteFail("GITHUB_BASE_CHANGED");
        if (action === "create_pr")
          await this.rest.assertNoDeletions(
            p,
            plan.baseSha,
            snapshot,
            assertAuthorized
          );
      }
      if (action === "sync")
        await this.rest.sync(p, plan, snapshot, assertAuthorized);
      else
        await this.rest.verifyCommit(p, plan, snapshot.tree, assertAuthorized);
      const previous = saved?.evidence
        ? JSON.parse(String(saved.evidence))
        : {};
      const evidence = {
        ...previous,
        ...plan,
        repositoryId: p.repositoryId,
        repository: `${p.owner}/${p.repo}`,
        observedAt: this.now(),
        source: "github-rest"
      };
      if (action === "create_pr")
        evidence.pullRequest = await this.rest.pullRequest(
          p,
          plan,
          assertAuthorized
        );
      if (action === "checks") {
        evidence.checks = await this.rest.checks(
          p,
          plan.remoteSha,
          assertAuthorized
        );
        evidence.checksObservedAt = this.now();
      }
      await this.rest.verifyCommit(p, plan, snapshot.tree, assertAuthorized);
      assertAuthorized();
      const current = this.state(id);
      this.local.verify(current, id);
      if (current.branches[commit.branch] !== commit.sha)
        remoteFail("GITHUB_LOCAL_HEAD_CHANGED");
      this.atomic(() => {
        assertAuthorized();
        if (this.state(id).branches[commit.branch] !== commit.sha)
          remoteFail("GITHUB_LOCAL_HEAD_CHANGED");
        this.db
          .prepare(
            "UPDATE github_deliveries SET evidence=? WHERE connection_id=? AND local_sha=?"
          )
          .run(JSON.stringify(evidence), connectionId, commit.sha);
        this.record(
          id,
          contract.version,
          access.identity.id,
          action as string,
          evidence
        );
      });
      return this.read(token, id);
    } catch (e) {
      new Audit(this.db).append("GitHub.operation", "rejected", {
        type: "contract",
        id
      });
      throw e;
    } finally {
      if (lease)
        this.db
          .prepare(
            "UPDATE github_connections SET lease=NULL,lease_until=0 WHERE contract_id=? AND lease=?"
          )
          .run(id, lease);
    }
  }
}
