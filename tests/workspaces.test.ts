import { FakeGitHubProvider } from "../packages/delivery/src/github.js";
import { FakeScanner } from "../packages/security/src/index.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { checksum, permissions } from "../packages/delivery/src/github.js";
import { ForbiddenError } from "../packages/auth/src/index.js";
import { workspaceRoute } from "../apps/server/src/workspaces.js";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
function fixture() {
  const f = setup();
  f.activate();
  const id = f.current().id;
  const service = new Workspaces(
    f.db,
    f.auth,
    () => 1000,
    new FakeGitHubProvider(new FakeScanner())
  );
  const agent = f.auth.issueAgentToken(
    f.seller,
    "agent-a",
    ["read", "write"].map(action => ({
      kind: "contract" as const,
      resourceId: id,
      action: action as "read" | "write"
    }))
  );
  let n = 0;
  const command = (
    action: string,
    extra: Record<string, unknown> = {},
    token = agent
  ) =>
    service.command(token, id, {
      action,
      version: 1,
      requestKey: `request-${++n}`,
      ...extra
    });
  const grant = (permission: string, ttlMs = 900000) =>
    command(
      "authorize",
      { actorId: "agent-a", permission, ttlMs, confirmed: true },
      f.buyer
    );
  return { ...f, id, service, agent, command, grant };
}
test("offline delivery lifecycle, evidence, idempotency, failure and checksum validation", () => {
  const f = fixture();
  try {
    for (const p of permissions) f.grant(p);
    const branch = { branch: "delivery", requestKey: "branch-once" };
    const first = f.command("create_workspace_branch", branch);
    assert.deepEqual(f.command("create_workspace_branch", branch), first);
    assert.equal(Object.keys(f.service.read(f.buyer, f.id).branches).length, 1);
    assert.throws(
      () =>
        f.command("create_workspace_branch", { ...branch, branch: "other" }),
      /REQUEST_KEY_REUSED/
    );
    f.command("commit", {
      branch: "delivery",
      summary: "实现",
      files: { "src/main.ts": "FAKE_FAIL_test" }
    });
    let sha = f.service.read(f.buyer, f.id).commits.at(-1)!.sha;
    f.command("run_check", { sha, kind: "test" });
    assert.equal(f.service.read(f.buyer, f.id).checks.at(-1)!.passed, false);
    assert.throws(
      () =>
        f.command("submit_milestone", {
          sha,
          milestoneId: f.current().milestones[0]!.id,
          summary: "交付"
        }),
      /EVIDENCE_INCOMPLETE/
    );
    f.command("commit", {
      branch: "delivery",
      summary: "修复",
      files: { "src/main.ts": "export const ready = true;" }
    });
    sha = f.service.read(f.buyer, f.id).commits.at(-1)!.sha;
    for (const kind of ["test", "typecheck"])
      f.command("run_check", { sha, kind });
    f.command("create_pull_request", { sha });
    assert.throws(
      () =>
        f.command("upload_artifact", {
          sha,
          name: "build.txt",
          content: "offline build",
          checksum: "bad"
        }),
      /CHECKSUM_MISMATCH/
    );
    f.command("upload_artifact", {
      sha,
      name: "build.txt",
      content: "offline build",
      checksum: checksum("offline build")
    });
    f.command("report_blocker", { text: "尚需人工验证预览" });
    const submission = {
      sha,
      milestoneId: f.current().milestones[0]!.id,
      summary: "交付摘要",
      previewUrl: "https://preview.invalid/build",
      requestKey: "submit-once"
    };
    f.command("submit_milestone", submission);
    f.command("submit_milestone", submission);
    const view = f.service.read(f.buyer, f.id);
    assert.equal(view.submissions.length, 1);
    assert.equal(view.artifacts[0]!.checksum, checksum("offline build"));
    assert.deepEqual(view.risks, ["尚需人工验证预览"]);
    assert.ok(view.auditEventReferences.length);
    assert.equal(
      f.contracts.read(f.buyer, f.id).milestones[0]!.status,
      "submitted"
    );
  } finally {
    f.db.close();
  }
});
test("read only, independent grants, revocation, expiry, path traversal and tenant boundaries", () => {
  const f = fixture();
  try {
    for (const action of [
      "create_workspace_branch",
      "commit",
      "run_check",
      "create_pull_request",
      "upload_artifact",
      "submit_milestone"
    ])
      assert.throws(() => f.command(action), ForbiddenError);
    f.grant("branch");
    for (const branch of [
      "../other",
      "/tmp/file",
      "a\\b",
      "a/%2e%2e",
      "__proto__"
    ])
      assert.throws(() => f.command("create_workspace_branch", { branch }));
    f.command("create_workspace_branch", { branch: "safe" });
    assert.throws(
      () => f.command("commit", { branch: "safe" }),
      ForbiddenError
    );
    f.grant("commit");
    assert.throws(
      () =>
        f.command("commit", {
          branch: "safe",
          summary: "变更",
          files: { "../outside": "content" }
        }),
      /INVALID_PATH/
    );
    f.grant("branch", 0);
    assert.throws(
      () => f.command("create_workspace_branch", { branch: "revoked" }),
      ForbiddenError
    );
    f.grant("branch", 1);
    const expired = new Workspaces(f.db, f.auth, () => 1002);
    assert.throws(
      () =>
        expired.command(f.agent, f.id, {
          action: "create_workspace_branch",
          branch: "expired",
          version: 1,
          requestKey: "expired"
        }),
      ForbiddenError
    );
    for (const token of [
      f.second,
      f.auth.issueUserSession("outsider"),
      f.auth.issueUserSession("admin")
    ])
      assert.throws(() => f.service.read(token, f.id), ForbiddenError);
    const secondTask = f.publish();
    const secondBid = f.submit(f.seller, secondTask);
    const secondContract = f.contracts.select(f.buyer, secondBid.id, true);
    assert.throws(
      () => f.service.read(f.agent, secondContract.id),
      ForbiddenError
    );
    const readOnly = f.auth.issueAgentToken(f.seller, "agent-a", [
      { kind: "contract", resourceId: f.id, action: "read" }
    ]);
    assert.equal(f.service.read(readOnly, f.id).contractId, f.id);
    assert.throws(
      () => f.service.command(readOnly, f.id, { action: "commit" }),
      ForbiddenError
    );
    assert.throws(
      () =>
        f.command("authorize", {
          actorId: "agent-a",
          permission: "branch",
          ttlMs: 100,
          confirmed: true
        }),
      ForbiddenError
    );
  } finally {
    f.db.close();
  }
});
test("dangerous actions only return expiring confirmation and audit failures roll back", () => {
  const f = fixture();
  try {
    for (const action of [
      "deploy",
      "migrate",
      "delete",
      "expand_permissions"
    ]) {
      const reply = f.command(action, {
        object: "合成目标",
        impactScope: "当前合同测试环境",
        confirmed: true
      }) as {
        result: {
          executed: boolean;
          requires_human_confirmation: boolean;
          expiresAt: number;
        };
      };
      assert.equal(reply.result.executed, false);
      assert.equal(reply.result.requires_human_confirmation, true);
      assert.equal(reply.result.expiresAt, 301000);
    }
    f.grant("branch");
    const before = f.service.read(f.buyer, f.id);
    f.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON contract_events BEGIN SELECT RAISE(ABORT, 'offline failure'); END;"
    );
    assert.throws(
      () => f.command("create_workspace_branch", { branch: "rolled-back" }),
      /offline failure/
    );
    assert.deepEqual(f.service.read(f.buyer, f.id), before);
    f.db.exec("DROP TRIGGER fail_delivery");
    f.db
      .prepare("UPDATE contracts SET status = 'disputed' WHERE id = ?")
      .run(f.id);
    assert.throws(
      () => f.command("deploy", { object: "目标", impactScope: "范围" }),
      /CONTRACT_NOT_ACTIVE/
    );
  } finally {
    f.db.close();
  }
});
test("workspace HTTP returns evidence and uniform forbidden errors", async () => {
  const f = fixture();
  try {
    async function request(token: string, id: string) {
      const req = Readable.from([]) as IncomingMessage;
      req.url = "/api/workspaces/" + id;
      req.method = "GET";
      req.rawHeaders = ["Authorization", "Bearer " + token];
      let output = "";
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: (v: string) => {
          output = v;
        }
      };
      await workspaceRoute(
        req,
        (res as unknown) as ServerResponse,
        "offline",
        f.service
      );
      return { status: res.statusCode, body: JSON.parse(output) };
    }
    assert.equal((await request(f.buyer, f.id)).body.data.taskVersion, 1);
    assert.deepEqual(
      await request(f.second, f.id),
      await request(f.second, "missing")
    );
  } finally {
    f.db.close();
  }
});

test("buyer evidence page renders structured evidence and clears on contract change", async () => {
  const { mountWorkspaces, renderWorkspaces } = await import(
    "../apps/web/src/workspaces.js"
  );
  assert.match(renderWorkspaces(), /制品 checksum/);
  class Element extends EventTarget {
    value = "";
    textContent = "";
  }
  const ids = [
    "session",
    "contract",
    "load",
    "status",
    "commits",
    "checks",
    "pullRequests",
    "artifacts",
    "submissions",
    "risks",
    "deployments",
    "context"
  ];
  const elements = new Map(ids.map(id => [id, new Element()]));
  const root = ({
    getElementById: (id: string) => elements.get(id)
  } as unknown) as Document;
  const original = globalThis.fetch;
  globalThis.fetch = ((async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        status: "active",
        commits: [{ summary: "完成变更" }],
        checks: [{ log: "PASS" }],
        pullRequests: [],
        artifacts: [{ checksum: "verified" }],
        submissions: [{ previewUrl: "https://preview.invalid" }],
        risks: ["需要人工验证"],
        deployments: [],
        taskVersion: 1,
        version: 1,
        discussions: [],
        auditEventReferences: [1]
      }
    })
  })) as unknown) as typeof fetch;
  try {
    mountWorkspaces(root);
    elements.get("load")!.dispatchEvent(new Event("click"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(elements.get("checks")!.textContent, /PASS/);
    assert.match(elements.get("risks")!.textContent, /需要人工验证/);
    assert.match(elements.get("artifacts")!.textContent, /verified/);
    elements.get("contract")!.dispatchEvent(new Event("input"));
    assert.equal(elements.get("artifacts")!.textContent, "");
  } finally {
    globalThis.fetch = original;
  }
});

test("credentials are rejected before workspace, audit or request persistence", () => {
  const f = fixture();
  try {
    for (const p of ["branch", "commit", "discussion"]) f.grant(p);
    f.command("create_workspace_branch", { branch: "delivery" });
    const persisted = () =>
      [
        "delivery_workspaces",
        "contract_events",
        "delivery_requests"
      ].map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    const before = persisted();
    const evidence = f.service.read(f.buyer, f.id);
    // Deliberately invalid placeholders, never real credentials.
    const samples = [
      "github_pat_SYNTHETIC_PLACEHOLDER",
      ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map(
        prefix => prefix + "SYNTHETIC_PLACEHOLDER"
      ),
      ...[
        "token",
        "cookie",
        "password",
        "secret",
        "access_token"
      ].flatMap(key => [
        JSON.stringify({ [key]: "SYNTHETIC_PLACEHOLDER" }),
        `{'${key}' : 'SYNTHETIC_PLACEHOLDER'}`
      ])
    ];
    for (const content of samples) {
      for (const action of ["discuss", "commit", "commit-summary"]) {
        assert.throws(
          () =>
            action === "discuss"
              ? f.command(action, { text: content })
              : f.command("commit", {
                  branch: "delivery",
                  summary: action === "commit-summary" ? content : "变更",
                  files: {
                    "safe.txt": "safe",
                    "content.txt": action === "commit" ? content : "safe"
                  }
                }),
          /SENSITIVE_CONTENT/
        );
        assert.deepEqual(persisted(), before);
        assert.deepEqual(f.service.read(f.buyer, f.id), evidence);
      }
    }
  } finally {
    f.db.close();
  }
});

test("commits preserve original whitespace, newlines and empty files", () => {
  const f = fixture();
  try {
    for (const p of ["branch", "commit"]) f.grant(p);
    f.command("create_workspace_branch", { branch: "delivery" });
    const files = {
      "indented.txt": "  indented\n\tcontent  \n",
      "newline.txt": "content\r\n",
      "empty.txt": "",
      "whitespace.txt": " \t\n"
    };
    f.command("commit", { branch: "delivery", summary: "变更", files });
    const commit = f.service.read(f.buyer, f.id).commits[0]!;
    assert.deepEqual(commit.files, files);
    assert.equal(
      commit.sha,
      checksum(JSON.stringify(["delivery", "", files, "变更", 1]))
    );
    const before = f.service.read(f.buyer, f.id);
    for (const invalid of [null, 123, {}, "x".repeat(10001)]) {
      assert.throws(
        () =>
          f.command("commit", {
            branch: "delivery",
            summary: "变更",
            files: { "invalid.txt": invalid }
          }),
        /INVALID_TEXT/
      );
      assert.deepEqual(f.service.read(f.buyer, f.id), before);
    }
  } finally {
    f.db.close();
  }
});

test("permission audit distinguishes validated subjects, grants, revocations and expiry", () => {
  const f = fixture();
  try {
    const change = (
      actorId: string,
      permission: string,
      ttlMs: number,
      requestKey: string
    ) =>
      f.command(
        "authorize",
        { actorId, permission, ttlMs, requestKey, confirmed: true },
        f.buyer
      );
    change("seller", "branch", 2000, "seller-grant");
    change("agent-a", "artifact", 3000, "agent-grant");
    change("agent-a", "artifact", 0, "agent-revoke");
    change("agent-a", "artifact", 3000, "agent-grant");
    const rows = f.db
      .prepare(
        "SELECT * FROM audit_events WHERE event = 'Workspaces.command.authorize' ORDER BY sequence"
      )
      .all();
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map(row => [
        row.target_subject,
        row.permission,
        row.permission_action,
        row.permission_expires_at
      ]),
      [
        ["user:seller", "branch", "grant", 3000],
        ["agent:agent-a", "artifact", "grant", 4000],
        ["agent:agent-a", "artifact", "revoke", 1000],
        ["agent:agent-a", "artifact", "grant", 4000]
      ]
    );
    for (const row of rows) {
      assert.equal(row.actor_id, "user:buyer");
      assert.equal(row.object_type, "contract");
      assert.equal(row.object_id, f.id);
      assert.equal(row.result, "success");
      assert.ok(row.request_id);
      assert.ok(
        JSON.parse(String(row.scope)).some(
          (scope: { resourceId: string; action: string }) =>
            scope.resourceId === f.id && scope.action === "write"
        )
      );
      assert.equal(row.scope, rows[0]!.scope);
    }
    // Replaying an earlier grant preserves its audit details without undoing revocation.
    assert.equal(
      f.db
        .prepare(
          "SELECT expires_at FROM delivery_permissions WHERE actor_id = 'agent-a' AND permission = 'artifact'"
        )
        .get()!.expires_at,
      1000
    );
    for (const [actor, permission, ttl] of [
      ["outsider", "branch", 1000],
      ["agent-a", "invalid", 1000],
      ["agent-a", "branch", -1]
    ] as const) {
      assert.throws(() => change(actor, permission, ttl, "rejected"));
      const rejected = f.db
        .prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 1")
        .get()!;
      assert.equal(rejected.result, "rejected");
      for (const key of [
        "target_subject",
        "permission",
        "permission_action",
        "permission_expires_at"
      ])
        assert.equal(rejected[key], null);
    }
    assert.throws(
      () => f.db.exec("UPDATE audit_events SET permission = 'commit'"),
      /immutable/
    );
    assert.throws(() => f.db.exec("DELETE FROM audit_events"), /immutable/);
    f.db.exec(
      "CREATE TRIGGER fail_permission_audit BEFORE INSERT ON audit_events WHEN NEW.event = 'Workspaces.command.authorize' AND NEW.result = 'success' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"
    );
    assert.throws(
      () => change("seller", "branch", 5000, "rollback"),
      /audit unavailable/
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT expires_at FROM delivery_permissions WHERE actor_id = 'seller' AND permission = 'branch'"
        )
        .get()!.expires_at,
      3000
    );
  } finally {
    f.db.close();
  }
});
