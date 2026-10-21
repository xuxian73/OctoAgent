import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { Contracts } from "./contracts.js";
import {
  checksum,
  FakeGitHubProvider,
  GitHubProvider,
  permissions,
  Permission,
  RepositoryState,
  text
} from "../../delivery/src/github.js";
export class Workspaces {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now,
    private provider: GitHubProvider = new FakeGitHubProvider()
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
    const row = this.db
      .prepare("SELECT * FROM delivery_workspaces WHERE contract_id = ?")
      .get(id);
    if (!row) throw new ForbiddenError();
    return {
      contract,
      access,
      row,
      state: JSON.parse(String(row.state)) as RepositoryState
    };
  }
  read(token: string, id: string) {
    const { contract, row, state } = this.access(token, id);
    return {
      contractId: id,
      version: contract.version,
      status: contract.status,
      taskVersion: row.task_version,
      provider: "offline-fake",
      ...state,
      auditEventReferences: contract.events
        .filter(e => String(e.kind).startsWith("workspace_"))
        .map(e => e.sequence)
    };
  }
  inspect(token: string, id: string, permission: Permission) {
    const { access, contract } = this.access(token, id, true);
    if (access.role !== "seller") throw new ForbiddenError();
    const grants = this.db
      .prepare(
        "SELECT permission FROM delivery_permissions WHERE contract_id = ? AND actor_id = ? AND expires_at > ?"
      )
      .all(id, access.identity.id, this.now())
      .map(row => String(row.permission));
    this.provider.authorize(permission, grants);
    if (contract.status !== "active")
      throw new RequirementError("CONTRACT_NOT_ACTIVE", 409);
    return this.read(token, id);
  }
  command(token: string, id: string, input: Record<string, unknown>) {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT workspaces_operation" : "BEGIN IMMEDIATE");
    try {
      const { contract, access, state } = this.access(token, id, true);
      if (contract.status !== "active")
        throw new RequirementError("CONTRACT_NOT_ACTIVE", 409);
      if (input.version !== contract.version)
        throw new RequirementError("STALE_CONTRACT", 409);
      const action = text(input.action);
      const key = text(input.requestKey);
      const sensitive = ["deploy", "migrate", "delete", "expand_permissions"];
      const required: Record<string, Permission> = {
        create_workspace_branch: "branch",
        commit: "commit",
        run_check: "check",
        create_pull_request: "pull_request",
        upload_artifact: "artifact",
        submit_milestone: "submit",
        discuss: "discussion",
        report_blocker: "discussion"
      };
      if (action === "authorize") {
        if (
          access.identity.kind !== "user" ||
          access.role !== "buyer" ||
          input.confirmed !== true
        )
          throw new ForbiddenError();
      } else {
        if (access.role !== "seller") throw new ForbiddenError();
        if (!sensitive.includes(action)) {
          if (!required[action]) throw new RequirementError("UNKNOWN_ACTION");
          const grants = this.db
            .prepare(
              "SELECT permission FROM delivery_permissions WHERE contract_id = ? AND actor_id = ? AND expires_at > ?"
            )
            .all(id, access.identity.id, this.now())
            .map(r => String(r.permission));
          this.provider.authorize(required[action]!, grants);
        }
      }
      const fingerprint = checksum(JSON.stringify(input));
      const prior = this.db
        .prepare(
          "SELECT * FROM delivery_requests WHERE contract_id = ? AND actor_id = ? AND request_key = ?"
        )
        .get(id, access.identity.id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new RequirementError("REQUEST_KEY_REUSED", 409);
        this.db.exec(nested ? "RELEASE workspaces_operation" : "COMMIT");
        return JSON.parse(String(prior.result));
      }
      let result: unknown;
      if (action === "authorize") {
        const actor = text(input.actorId);
        const permission = text(input.permission);
        if (!permissions.includes(permission as Permission))
          throw new RequirementError("INVALID_PERMISSION");
        const agent = this.db
          .prepare("SELECT responsible_user_id FROM agents WHERE id = ?")
          .get(actor);
        if (
          actor !== contract.seller_id &&
          agent?.responsible_user_id !== contract.seller_id
        )
          throw new ForbiddenError();
        const ttl = input.ttlMs;
        if (
          typeof ttl !== "number" ||
          !Number.isSafeInteger(ttl) ||
          ttl < 0 ||
          ttl > 900000
        )
          throw new RequirementError("INVALID_TTL");
        this.db
          .prepare(
            "INSERT INTO delivery_permissions VALUES (?,?,?,?) ON CONFLICT(contract_id,actor_id,permission) DO UPDATE SET expires_at = excluded.expires_at"
          )
          .run(id, actor, permission, this.now() + ttl);
        result = {
          actor,
          permission,
          expiresAt: this.now() + ttl,
          revoked: ttl === 0
        };
      } else if (sensitive.includes(action)) {
        result = {
          requires_human_confirmation: true,
          action,
          object: text(input.object),
          impactScope: text(input.impactScope),
          expiresAt: this.now() + 300000,
          executed: false,
          productionEnabled: false
        };
        state.deployments.push(result);
      } else if (action === "create_workspace_branch")
        result = this.provider.createBranch(state, text(input.branch));
      else if (action === "commit")
        result = this.provider.commit(
          state,
          text(input.branch),
          input.files as Record<string, string>,
          text(input.summary),
          contract.version
        );
      else if (action === "run_check")
        result = this.provider.runCheck(
          state,
          text(input.sha),
          text(input.kind)
        );
      else if (action === "create_pull_request")
        result = this.provider.createPullRequest(state, text(input.sha));
      else if (action === "upload_artifact")
        result = this.provider.uploadArtifact(
          state,
          text(input.sha),
          text(input.name),
          typeof input.content === "string"
            ? input.content
            : text(input.content),
          text(input.checksum)
        );
      else if (action === "discuss" || action === "report_blocker") {
        const value = text(input.text);
        (action === "discuss" ? state.discussions : state.risks).push(value);
        result = { text: value };
      } else if (action === "submit_milestone") {
        const sha = text(input.sha);
        const commit = state.commits.find(
          c => c.sha === sha && c.version === contract.version
        );
        if (
          !commit ||
          state.branches[commit.branch] !== sha ||
          !["test", "typecheck"].every(
            kind =>
              state.checks.filter(c => c.sha === sha && c.kind === kind).at(-1)
                ?.passed
          ) ||
          !state.pullRequests.some(p => p.sha === sha) ||
          !state.artifacts.some(a => a.sha === sha)
        )
          throw new RequirementError("EVIDENCE_INCOMPLETE", 409);
        const milestoneId = text(input.milestoneId);
        const milestone = contract.milestones.find(
          m => m.id === milestoneId && m.version === contract.version
        );
        if (
          !milestone ||
          !["planned", "in_progress", "changes_requested"].includes(
            String(milestone.status)
          )
        )
          throw new RequirementError("INVALID_MILESTONE", 409);
        let previewUrl: string | null = null;
        if (input.previewUrl) {
          previewUrl = text(input.previewUrl);
          const url = new URL(previewUrl);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new RequirementError("INVALID_PREVIEW_URL");
        }
        result = {
          milestoneId,
          sha,
          version: contract.version,
          summary: text(input.summary),
          previewUrl,
          risks: [...state.risks],
          checks: state.checks.filter(c => c.sha === sha),
          pullRequests: state.pullRequests.filter(p => p.sha === sha),
          artifacts: state.artifacts.filter(a => a.sha === sha)
        };
        state.submissions.push(result);
        this.db
          .prepare("UPDATE milestones SET status = 'submitted' WHERE id = ?")
          .run(milestoneId);
      }
      const envelope = {
        status: contract.status,
        summary: "工作区操作已记录",
        next_step: sensitive.includes(action)
          ? "等待人工确认；生产执行不可用"
          : "查看交付证据",
        result
      };
      this.db
        .prepare(
          "UPDATE delivery_workspaces SET state = ? WHERE contract_id = ?"
        )
        .run(JSON.stringify(state), id);
      this.db
        .prepare(
          "INSERT INTO contract_events(contract_id,version,actor_id,created_at,kind,payload) VALUES (?,?,?,?,?,?)"
        )
        .run(
          id,
          contract.version,
          access.identity.id,
          this.now(),
          "workspace_" + action,
          JSON.stringify(result)
        );
      this.db
        .prepare("UPDATE contracts SET revision = revision + 1 WHERE id = ?")
        .run(id);
      this.db
        .prepare("INSERT INTO delivery_requests VALUES (?,?,?,?,?)")
        .run(
          id,
          access.identity.id,
          key,
          fingerprint,
          JSON.stringify(envelope)
        );
      this.db.exec(nested ? "RELEASE workspaces_operation" : "COMMIT");
      return envelope;
    } catch (error) {
      this.db.exec(
        nested
          ? "ROLLBACK TO workspaces_operation; RELEASE workspaces_operation"
          : "ROLLBACK"
      );
      throw error;
    }
  }
}
