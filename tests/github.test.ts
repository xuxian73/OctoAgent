import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, Agent } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./fixtures/contracts.js";
import { LocalGitProvider } from "../packages/delivery/src/local-git.js";
import {
  GitHubRest,
  GitHubProfile,
  gitHash
} from "../packages/delivery/src/github-rest.js";
import { GitHubConnections } from "../packages/database/src/github.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { ForbiddenError } from "../packages/auth/src/index.js";
import { RepositoryState } from "../packages/delivery/src/github.js";

async function fixture() {
  const f = setup();
  f.activate();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octo-github-")));
  const id = f.current().id;
  const local = new LocalGitProvider(root);
  const workspaces = new Workspaces(f.db, f.auth, () => 1000, local);
  for (const permission of ["branch", "commit", "pull_request"])
    workspaces.command(f.buyer, id, {
      action: "authorize",
      version: 1,
      requestKey: permission,
      confirmed: true,
      actorId: "seller",
      ttlMs: 900000,
      permission
    });
  const state = JSON.parse(
    String(
      f.db
        .prepare("SELECT state FROM delivery_workspaces WHERE contract_id=?")
        .get(id)!.state
    )
  ) as RepositoryState;
  local.initialize(state, id);
  local.createBranch(state, "delivery");
  const bytes = Buffer.from("verified local bytes\n");
  const { createHash } = await import("node:crypto");
  const commit = local.importArtifact(
    state,
    id,
    "delivery",
    "src/code.txt",
    bytes,
    "delivery",
    1,
    "source",
    createHash("sha256")
      .update(bytes)
      .digest("hex")
  );
  f.db
    .prepare("UPDATE delivery_workspaces SET state=? WHERE contract_id=?")
    .run(JSON.stringify(state), id);
  const snapshot = local.snapshot(state, id, commit.sha);
  const secret = randomBytes(32).toString("hex");
  const repository = {
    id: 42,
    full_name: "test-owner/test-repo",
    html_url: "https://github.com/test-owner/test-repo"
  };
  let now = 1000;
  const profile: GitHubProfile = {
    id: "test",
    contractId: id,
    responsibleUserId: "buyer",
    repositoryId: 42,
    owner: "test-owner",
    repo: "test-repo",
    base: "main",
    credentialEnv: "OCTO_GITHUB_CREDENTIAL_TEST",
    allowed: ["read", "write", "create_pr"],
    expiresAt: 900000
  };
  const refs = new Map([["main", "a".repeat(40)]]);
  const baseTree = {
    sha: "c".repeat(40),
    truncated: false,
    tree: [] as { path: string; type: string }[]
  };
  const commits = new Map<string, any>([
    [
      "a".repeat(40),
      {
        sha: "a".repeat(40),
        tree: { sha: baseTree.sha }
      }
    ]
  ]);
  const pulls: any[] = [];
  const seen: { method: string; path: string; body: any }[] = [];
  let bad = "";
  let hook: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname.replace("/repos/test-owner/test-repo", "");
    seen.push({ method: req.method!, path: path + url.search, body });
    const reply = (data: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (bad === "error") return reply({ message: secret }, 500);
    if (bad === "redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/leak" });
      res.end();
      return;
    }
    hook?.();
    hook = undefined;
    if (!path) return reply({ ...repository, id: bad === "repo" ? 9 : 42 });
    if (path.startsWith("/git/ref/heads/")) {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      return refs.has(branch)
        ? reply({
            ref: `refs/heads/${branch}`,
            object: {
              type: "commit",
              sha: bad === "ref" ? "b".repeat(40) : refs.get(branch)
            }
          })
        : reply({}, 404);
    }
    if (path === "/git/blobs") {
      assert.equal(body.encoding, "base64");
      return reply(
        { sha: gitHash("blob", Buffer.from(body.content, "base64")) },
        201
      );
    }
    if (path === `/git/trees/${baseTree.sha}`) return reply(baseTree);
    if (path === "/git/trees") {
      assert.deepEqual(
        body.tree,
        snapshot.files.map(file => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: file.sha
        }))
      );
      return reply(
        { sha: bad === "tree" ? "b".repeat(40) : snapshot.tree },
        201
      );
    }
    if (path === "/git/commits") {
      assert.equal(body.author.date, "2000-01-01T00:00:00Z");
      const raw = `tree ${body.tree}\nparent ${body.parents[0]}\nauthor OctoAgent <local@invalid> 946684800 +0000\ncommitter OctoAgent <local@invalid> 946684800 +0000\n\n${body.message}`;
      const sha = gitHash("commit", raw);
      commits.set(sha, {
        sha,
        message: body.message,
        parents: body.parents.map((sha: string) => ({ sha })),
        tree: { sha: body.tree }
      });
      return reply({ sha }, 201);
    }
    if (path.startsWith("/git/commits/"))
      return reply(commits.get(path.split("/").at(-1)!) || {}, 200);
    if (path === "/git/refs") {
      const name = body.ref.slice("refs/heads/".length);
      if (refs.has(name)) return reply({}, 422);
      refs.set(name, body.sha);
      if (bad === "lost-ref") {
        bad = "";
        res.destroy();
        return;
      }
      return reply(
        { ref: body.ref, object: { type: "commit", sha: body.sha } },
        201
      );
    }
    if (path === "/pulls" && req.method === "GET")
      return reply(
        pulls.filter(
          p => `${profile.owner}:${p.head.ref}` === url.searchParams.get("head")
        )
      );
    if (path === "/pulls" && req.method === "POST") {
      const number = pulls.length + 1;
      const pr = {
        number,
        html_url: `${repository.html_url}/pull/${number}`,
        state: "open",
        head: { repo: repository, ref: body.head, sha: refs.get(body.head) },
        base: { repo: repository, ref: body.base }
      };
      pulls.push(pr);
      if (bad === "lost-pr") {
        bad = "";
        res.destroy();
        return;
      }
      return reply(pr, 201);
    }
    if (path.startsWith("/pulls/")) {
      const pr = structuredClone(pulls[Number(path.split("/").at(-1)) - 1]);
      if (bad === "pr") pr.head.repo.id = 999;
      if (bad === "pr-number") pr.number = 999;
      return reply(pr);
    }
    if (path.endsWith("/check-runs")) {
      return reply({
        total_count: 1,
        check_runs: [
          {
            id: 1,
            head_sha: bad === "check" ? "b".repeat(40) : path.split("/")[2],
            status: "completed",
            conclusion: "success",
            output: { summary: secret }
          }
        ]
      });
    }
    return reply({}, 404);
  });
  // Real Node HTTP serialization/parsing over a local byte stream: no listening
  // socket needed in sandboxes that prohibit bind(). The production transport is fetch.
  const transport: typeof fetch = async (url, options) => {
    const outgoing = new PassThrough();
    const incoming = new PassThrough();
    const client = Duplex.from({ readable: incoming, writable: outgoing });
    const peer = Duplex.from({ readable: outgoing, writable: incoming });
    const agent = new Agent();
    agent.createConnection = () => client as Socket;
    server.emit("connection", peer);
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        String(url),
        {
          method: options?.method,
          headers: options?.headers as Record<string, string>,
          agent,
          signal: options?.signal || undefined
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(Buffer.from(chunk)));
          res.on("error", reject);
          res.on("end", () => {
            agent.destroy();
            if (res.statusCode! >= 300 && res.statusCode! < 400) {
              reject(new Error("redirect rejected"));
              return;
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode })
            );
          });
        }
      );
      req.on("error", error => {
        agent.destroy();
        reject(error);
      });
      req.end(options?.body);
    });
  };
  const rest = new GitHubRest(
    ref => (ref === profile.credentialEnv ? secret : undefined),
    "http://127.0.0.1:12345",
    transport
  );
  const service = () =>
    new GitHubConnections(
      f.db,
      f.auth,
      local,
      () => [profile],
      rest,
      () => now
    );
  const command = (
    action: string,
    extra: Record<string, unknown> = {},
    token = f.seller
  ) =>
    service().command(token, id, {
      action,
      version: 1,
      sha: commit.sha,
      ...extra
    });
  const prepare = async (scopes?: string[]) => {
    const fields = { profileId: "test", scopes, ttlMs: 900000 };
    const plan = await command("prepare_connect", fields, f.buyer);
    assert.ok("confirmationId" in plan);
    return { ...fields, confirmed: true, confirmationId: plan.confirmationId };
  };
  const connect = async (scopes: string[] = ["read", "write", "create_pr"]) =>
    command("connect", await prepare(scopes), f.buyer);
  return {
    ...f,
    workspaces,
    prepare,
    baseTree,
    id,
    root,
    commit,
    profile,
    secret,
    seen,
    refs,
    pulls,
    command,
    connect,
    service,
    setBad: (v: string) => {
      bad = v;
    },
    advance: (n: number) => {
      now += n;
    },
    hook: (fn: () => void) => {
      hook = fn;
    },
    close: async () => {
      server.close();
      f.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("REST stub: real local objects → remote branch/commit → PR/checks, immutable SHA mapping and safe projections", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service().read(f.seller, f.id).mode, "local-git");
    await f.connect();
    await f.command("sync");
    await f.command("create_pr");
    await f.command("checks");
    const data = f.service().read(f.seller, f.id);
    const e = data.evidence[0];
    assert.equal(e.localSha, f.commit.sha);
    assert.notEqual(e.remoteSha, e.localSha);
    assert.equal(e.checks[0].remoteSha, e.remoteSha);
    assert.equal(
      e.pullRequest.url,
      "https://github.com/test-owner/test-repo/pull/1"
    );
    assert.ok(f.seen.some(r => r.path === "/git/blobs"));
    assert.ok(f.seen.some(r => r.path === "/git/trees"));
    assert.ok(
      f.seen.some(r => r.path.includes(`/commits/${e.remoteSha}/check-runs`))
    );
    assert.equal(JSON.stringify(data).includes(f.secret), false);
    assert.equal(
      JSON.stringify(f.db.prepare("SELECT * FROM audit_events").all()).includes(
        f.secret
      ),
      false
    );
    assert.equal(
      JSON.stringify(
        f.db.prepare("SELECT * FROM github_deliveries").all()
      ).includes(f.secret),
      false
    );
    assert.equal(JSON.stringify(data).includes("credentialEnv"), false);
    const state = JSON.parse(
      String(
        f.db
          .prepare("SELECT state FROM delivery_workspaces WHERE contract_id=?")
          .get(f.id)!.state
      )
    );
    assert.deepEqual(state.checks, []);
    assert.deepEqual(state.pullRequests, []);
  } finally {
    await f.close();
  }
});

test("default read, independent scope ceilings, party/grants, expiry, revocation and disabled merge/deploy", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connect(["merge"]), ForbiddenError);
    await assert.rejects(
      f.command("connect", {
        profileId: "test",
        confirmed: true,
        ttlMs: 900000
      }),
      ForbiddenError
    );
    await f.command("connect", await f.prepare(), f.buyer);
    for (const action of ["sync", "create_pr"])
      await assert.rejects(f.command(action), ForbiddenError);
    for (const action of ["merge", "deploy"])
      await assert.rejects(f.command(action), /GITHUB_ACTION_DISABLED/);
    f.profile.allowed = ["read"];
    await assert.rejects(f.connect(), ForbiddenError);
    f.profile.allowed = ["read", "write", "create_pr"];
    await f.connect(["read", "create_pr"]);
    await assert.rejects(f.command("sync"), ForbiddenError);
    await f.connect(["read", "write"]);
    await assert.rejects(f.command("create_pr"), ForbiddenError);
    await assert.rejects(f.command("sync", {}, f.second), ForbiddenError);
    f.db
      .prepare(
        "UPDATE delivery_permissions SET expires_at=0 WHERE permission='commit'"
      )
      .run();
    await assert.rejects(f.command("sync"), ForbiddenError);
    f.db
      .prepare(
        "UPDATE delivery_permissions SET expires_at=900000 WHERE permission='commit'"
      )
      .run();
    await f.command("sync");
    await f.command("revoke", { confirmed: true }, f.buyer);
    await assert.rejects(f.command("sync"), ForbiddenError);
    await f.connect();
    f.advance(900001);
    await assert.rejects(f.command("sync"), ForbiddenError);
    assert.equal(f.service().read(f.seller, f.id).mode, "local-git");
  } finally {
    await f.close();
  }
});

test("remote identity/errors reject evidence; lost replies/restarts/concurrent retries create only one PR", async () => {
  const f = await fixture();
  try {
    await f.connect();
    for (const bad of ["repo", "redirect", "error", "tree"]) {
      f.setBad(bad);
      await assert.rejects(f.command("sync"));
      assert.equal(f.service().read(f.seller, f.id).evidence.length, 0);
    }
    f.setBad("lost-ref");
    await f.command("sync");
    f.setBad("lost-pr");
    await f.command("create_pr");
    const results = await Promise.allSettled([
      f.command("create_pr"),
      f.command("create_pr")
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(f.pulls.length, 1);
    await f.command("create_pr");
    assert.equal(f.pulls.length, 1);
    const before = JSON.stringify(f.service().read(f.seller, f.id).evidence);
    for (const bad of ["pr", "pr-number", "ref"]) {
      f.setBad(bad);
      await assert.rejects(f.command("create_pr"));
      assert.equal(
        JSON.stringify(f.service().read(f.seller, f.id).evidence),
        before
      );
    }
    f.setBad("check");
    await assert.rejects(f.command("checks"));
    assert.equal(
      JSON.stringify(f.service().read(f.seller, f.id).evidence),
      before
    );
    f.setBad("");
    f.hook(() => {
      f.db
        .prepare("UPDATE github_connections SET revoked=1 WHERE contract_id=?")
        .run(f.id);
    });
    await assert.rejects(f.command("checks"), ForbiddenError);
    assert.equal(
      JSON.stringify(f.service().read(f.seller, f.id).evidence),
      before
    );
  } finally {
    await f.close();
  }
});

test("durable plan resumes after database failure, lease expiry and reconnection; stale local evidence is rejected", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.db.exec(
      `CREATE TRIGGER reject_remote_evidence BEFORE UPDATE OF evidence ON github_deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`
    );
    await assert.rejects(f.command("sync"), /injected failure/);
    assert.equal(f.service().read(f.seller, f.id).evidence.length, 0);
    assert.equal(f.refs.size, 2);
    f.db.exec("DROP TRIGGER reject_remote_evidence");
    await f.command("sync");
    f.db.exec(
      `CREATE TRIGGER reject_remote_evidence BEFORE UPDATE OF evidence ON github_deliveries BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`
    );
    await assert.rejects(f.command("create_pr"), /injected failure/);
    assert.equal(f.pulls.length, 1);
    f.db.exec("DROP TRIGGER reject_remote_evidence");
    f.db
      .prepare(
        "UPDATE github_connections SET lease='interrupted-worker',lease_until=31000"
      )
      .run();
    await assert.rejects(f.command("create_pr"), /GITHUB_BUSY/);
    f.advance(30001);
    await f.command("create_pr");
    assert.equal(f.pulls.length, 1);
    await f.command("revoke", { confirmed: true }, f.buyer);
    await f.connect();
    await f.command("create_pr");
    assert.equal(f.pulls.length, 1);
    f.db.prepare("UPDATE contracts SET version=2 WHERE id=?").run(f.id);
    await assert.rejects(f.command("checks"), /STALE_CONTRACT/);
    await assert.rejects(f.command("checks", { version: 2 }), ForbiddenError);
  } finally {
    await f.close();
  }
});

test("browser entry confirms read-only by default, offers independent PR actions and renders real links", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  try {
    const { renderWorkspaces, mountWorkspaces } = await import(
      "../apps/web/src/workspaces.js"
    );
    class Element extends EventTarget {
      value = "";
      textContent = "";
      hidden = false;
      checked = false;
      href = "";
      children: Element[] = [];
      append(child: Element) {
        this.children.push(child);
        if (!this.value) this.value = child.value;
      }
      replaceChildren() {
        this.children = [];
        this.value = "";
      }
      click() {
        this.dispatchEvent(new Event("click"));
      }
    }
    const elements = new Map(
      [...renderWorkspaces().matchAll(/id="([^"]+)"/g)].map(m => [
        m[1]!,
        new Element()
      ])
    );
    const el = (id: string) => elements.get(id)!;
    const root = (Object.assign(new EventTarget(), {
      getElementById: (id: string) => elements.get(id),
      createElement: () => new Element()
    }) as unknown) as Document;
    let token = f.buyer;
    const submitted: Record<string, unknown>[] = [];
    let pending = 0;
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      pending++;
      try {
        let data: unknown;
        if (url === "/api/auth/me") data = { csrf: "test-csrf" };
        else if (url === "/api/contracts") data = [f.current()];
        else if (url.startsWith("/api/files?")) data = [];
        else if (url.endsWith("/github")) {
          if (options?.method === "POST") {
            const body = JSON.parse(String(options.body));
            submitted.push(body);
            data = await f.service().command(token, f.id, body);
          } else data = f.service().read(token, f.id);
        } else data = f.workspaces.read(token, f.id);
        return { ok: true, json: async () => ({ ok: true, data }) } as Response;
      } finally {
        pending--;
      }
    }) as typeof fetch;
    const settle = async () => {
      do {
        for (let i = 0; i < 10; i++)
          await new Promise<void>(r => setImmediate(r));
      } while (pending);
    };
    Object.assign(el("git-extension"), { open: true });
    mountWorkspaces(root);
    await settle();
    assert.match(el("github-status").textContent, /本地 Git/);
    assert.equal(el("github-profile").value, "test");
    el("github-confirm").checked = true;
    el("github-connect").dispatchEvent(
      new Event("submit", { cancelable: true })
    );
    await settle();
    assert.equal(el("github-confirm").checked, false);
    el("github-confirm").checked = true;
    el("github-connect").dispatchEvent(
      new Event("submit", { cancelable: true })
    );
    await settle();
    assert.deepEqual(submitted[0]!.scopes, ["read"]);
    assert.equal(el("github-sync").hidden, true);
    el("github-confirm").checked = true;
    el("github-write").checked = true;
    el("github-pr").checked = true;
    el("github-connect").dispatchEvent(
      new Event("submit", { cancelable: true })
    );
    await settle();
    el("github-confirm").checked = true;
    el("github-connect").dispatchEvent(
      new Event("submit", { cancelable: true })
    );
    await settle();
    token = f.seller;
    el("load").click();
    await settle();
    assert.equal(el("github-connect").hidden, true);
    assert.equal(el("github-sync").hidden, false);
    el("github-sync").click();
    await settle();
    el("github-create-pr").click();
    await settle();
    el("github-checks").click();
    await settle();
    assert.equal(
      el("github-links").children[0]!.href,
      "https://github.com/test-owner/test-repo/pull/1"
    );
    assert.match(el("github-evidence").textContent, /remoteSha/);
    assert.equal(el("github-evidence").textContent.includes(f.secret), false);
    el("contract").dispatchEvent(new Event("input"));
    assert.equal(el("github-controls").hidden, true);
    assert.equal(el("github-evidence").textContent, "");
    assert.equal(el("github-links").children.length, 0);
    assert.equal(renderWorkspaces().includes("localStorage"), false);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

test("private deployment profiles reject unsafe permissions, credential references and unsupported scopes", async () => {
  const { loadGitHubProfiles } = await import(
    "../packages/delivery/src/github-rest.js"
  );
  const { writeFileSync, chmodSync } = await import("node:fs");
  const f = await fixture();
  const old = process.env.OCTO_GITHUB_CONFIG;
  try {
    const path = join(f.root, "profiles.json");
    process.env.OCTO_GITHUB_CONFIG = path;
    writeFileSync(path, JSON.stringify([f.profile]), { mode: 0o600 });
    assert.deepEqual(loadGitHubProfiles(), [f.profile]);
    chmodSync(path, 0o644);
    assert.throws(loadGitHubProfiles, /GITHUB_CONFIGURATION_INVALID/);
    chmodSync(path, 0o600);
    for (const changed of [
      { credentialEnv: "GH_TOKEN" },
      { allowed: ["read", "merge"] },
      { allowed: ["deploy"] },
      { repo: "../other" }
    ]) {
      writeFileSync(path, JSON.stringify([{ ...f.profile, ...changed }]));
      assert.throws(loadGitHubProfiles, /GITHUB_CONFIGURATION_INVALID/);
    }
    delete process.env.OCTO_GITHUB_CONFIG;
    assert.deepEqual(loadGitHubProfiles(), []);
  } finally {
    if (old === undefined) delete process.env.OCTO_GITHUB_CONFIG;
    else process.env.OCTO_GITHUB_CONFIG = old;
    await f.close();
  }
});

test("one-time connection plans reject replay, stale scopes/configuration and expiry", async () => {
  const f = await fixture();
  try {
    const old = await f.prepare(["read", "write", "create_pr"]);
    const delayed = await f.prepare(["read", "write"]);
    await f.command("connect", old, f.buyer);
    const expiry = f.service().read(f.buyer, f.id).connection!.expiresAt;
    f.advance(100);
    await assert.rejects(
      f.command("connect", old, f.buyer),
      /CONFIRMATION_INVALID/
    );
    assert.equal(f.service().read(f.buyer, f.id).connection!.expiresAt, expiry);
    const beforeRevoke = await f.prepare(["read", "write"]);
    await f.command("revoke", { confirmed: true }, f.buyer);
    for (const fields of [old, delayed, beforeRevoke])
      await assert.rejects(
        f.command("connect", fields, f.buyer),
        /CONFIRMATION_INVALID/
      );
    const beforeDowngrade = await f.prepare(["read", "write"]);
    await f.connect(["read"]);
    await assert.rejects(
      f.command("connect", beforeDowngrade, f.buyer),
      /CONFIRMATION_INVALID/
    );
    await assert.rejects(
      f.command("connect", old, f.buyer),
      /CONFIRMATION_INVALID/
    );
    await assert.rejects(f.command("sync"), ForbiddenError);
    const fresh = await f.prepare(["read"]);
    await assert.rejects(
      f.command("connect", { ...fresh, confirmationId: undefined }, f.buyer),
      /CONFIRMATION_INVALID/
    );
    await assert.rejects(
      f.command("connect", { ...fresh, ttlMs: 800000 }, f.buyer),
      /CONFIRMATION_INVALID/
    );
    await assert.rejects(
      f.command("connect", { ...fresh, scopes: ["read", "write"] }, f.buyer),
      /CONFIRMATION_INVALID/
    );
    f.profile.base = "other";
    await assert.rejects(
      f.command("connect", fresh, f.buyer),
      /CONFIRMATION_INVALID/
    );
    f.profile.base = "main";
    const shortFields = { profileId: "test", scopes: ["read"], ttlMs: 100 };
    const shortPlan = await f.command("prepare_connect", shortFields, f.buyer);
    assert.ok("confirmationId" in shortPlan);
    f.advance(101);
    await assert.rejects(
      f.command(
        "connect",
        {
          ...shortFields,
          confirmed: true,
          confirmationId: shortPlan.confirmationId
        },
        f.buyer
      ),
      /CONFIRMATION_INVALID/
    );
    f.db.prepare("UPDATE contracts SET version=2 WHERE id=?").run(f.id);
    await assert.rejects(
      f.command("connect", { ...fresh, version: 2 }, f.buyer),
      /CONFIRMATION_INVALID/
    );
  } finally {
    await f.close();
  }
});

test("full snapshots reject remote deletions before any writes, including retries and changed baseline", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.baseTree.tree = [
      { path: "src", type: "tree" },
      { path: "src/code.txt", type: "blob" },
      { path: "important.txt", type: "blob" },
      { path: "nested/keep.txt", type: "blob" }
    ];
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        f.command("sync", { confirmed: true }),
        /GITHUB_DELETION_DISABLED.*important.txt.*nested\/keep.txt/
      );
      assert.equal(
        f.seen.some(r => r.method === "POST"),
        false
      );
      assert.equal(f.service().read(f.seller, f.id).evidence.length, 0);
    }
    f.baseTree.tree = [{ path: "src/code.txt", type: "blob" }];
    f.baseTree.truncated = true;
    await assert.rejects(f.command("sync"), /GITHUB_BASE_TREE_INCOMPLETE/);
    assert.equal(
      f.seen.some(r => r.method === "POST"),
      false
    );
    f.baseTree.truncated = false;
    await f.command("sync");
    f.refs.set("main", "b".repeat(40));
    await assert.rejects(f.command("sync"), /GITHUB_BASE_CHANGED/);
    await assert.rejects(f.command("create_pr"), /GITHUB_BASE_CHANGED/);
    assert.equal(f.pulls.length, 0);
  } finally {
    await f.close();
  }
});
