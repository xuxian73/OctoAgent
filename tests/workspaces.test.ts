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
  const service = new Workspaces(f.db, f.auth, () => 1000);
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

test("buyer evidence page renders structured evidence and clears on identity change", async () => {
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
    elements.get("session")!.dispatchEvent(new Event("input"));
    assert.equal(elements.get("artifacts")!.textContent, "");
  } finally {
    globalThis.fetch = original;
  }
});
