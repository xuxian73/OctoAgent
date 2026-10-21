import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { Authorization, ForbiddenError } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { Requirements } from "../packages/database/src/requirements.js";
import { Market } from "../packages/database/src/market.js";
import {
  Draft,
  fields,
  contextFields
} from "../packages/requirements/src/model.js";
import { Proposal } from "../packages/requirements/src/bids.js";
import { seedIdentities } from "./fixtures/identity.js";
import {
  Contracts,
  contractBodyLimit
} from "../packages/database/src/contracts.js";
import { contractRoute } from "../apps/server/src/contracts.js";
import { setup, fixture } from "./fixtures/contracts.js";
const reason = { code: "scope", detail: "合成验收原因" };
const offer: Proposal = {
  summary: "可验证交付",
  milestones: ["实现", "验收"],
  hours: 40,
  days: 10,
  price: 100,
  prerequisites: ["无"],
  risks: ["依赖不确定"],
  risk: "low",
  permissions: ["测试只读"],
  evidence: ["离线报告"],
  capabilities: ["TypeScript", "testing"]
};
test("selection is unique, snapshots scope, denies strangers and stale/unsubmitted bids", () => {
  const f = setup();
  try {
    assert.equal(f.current().status, "draft");
    assert.deepEqual(f.contracts.select(f.buyer, f.bid.id, true), f.current());
    assert.match(f.current().versions[0]!.terms.scope, /范围排除/);
    assert.equal(f.current().versions[0]!.terms.price, offer.price);
    const other = f.submit(f.second, f.task);
    assert.throws(
      () => f.contracts.select(f.buyer, other.id, true),
      /BID_ALREADY_SELECTED/
    );
    assert.throws(
      () => f.contracts.select(f.seller, f.bid.id, true),
      ForbiddenError
    );
    for (const token of [
      f.second,
      f.auth.issueUserSession("outsider"),
      f.auth.issueUserSession("admin")
    ])
      for (const id of [String(f.current().id), "missing"])
        assert.throws(() => f.contracts.read(token, id), ForbiddenError);
    const draft = f.market.draft(f.seller, f.publish(), offer);
    assert.throws(
      () => f.contracts.select(f.buyer, draft.id, true),
      ForbiddenError
    );
    const task = f.publish();
    const stale = f.submit(f.seller, task);
    f.req.save(f.buyer, task, f.req.read(f.buyer, task).revision, f.draft);
    f.req.publish(
      f.buyer,
      task,
      f.req.preview(f.buyer, task).confirmation,
      true
    );
    assert.throws(
      () => f.contracts.select(f.buyer, stale.id, true),
      /STALE_BID/
    );
  } finally {
    f.db.close();
  }
});
test("selection preserves maximum-length source fields and all delivery evidence", async () => {
  const f = fixture();
  try {
    const values = {
      ...f.draft.values,
      goal: "目".repeat(10000),
      permissions: "权".repeat(10000),
      exclusions: "除".repeat(10000),
      deliverables: "交".repeat(10000),
      acceptance: "验".repeat(10000)
    };
    const proposal = {
      ...offer,
      summary: "摘".repeat(10000),
      evidence: Array.from({ length: 100 }, (_, i) =>
        String(i).padEnd(10000, "证")
      ),
      milestones: Array.from({ length: 100 }, () => "里".repeat(10000))
    };
    const task = f.publish({ ...f.draft, values });
    const bid = f.submit(f.seller, task, proposal);
    const selected = await request(f.contracts, f.buyer, "/select", {
      bidId: bid.id,
      confirmed: true
    });
    assert.equal(selected.status, 200);
    let contract = f.contracts.read(f.buyer, selected.body.data.id);
    const original = contract.versions[0]!;
    assert.deepEqual(original.terms, {
      scope: `${values.goal}\n${proposal.summary}\n权限：${values.permissions}\n范围排除：${values.exclusions}`,
      deliverables: [values.deliverables, ...proposal.evidence].join("\n"),
      acceptance: values.acceptance,
      changeRules: "任一方提出范围变更，生成新版本，双方人工重新确认后生效。",
      price: proposal.price,
      currency: "CNY",
      milestones: proposal.milestones
    });
    assert.deepEqual(f.contracts.select(f.buyer, bid.id, true), contract);
    let sequence = 0;
    const command = async (token: string, action: string, extra = {}) => {
      const result = await request(
        f.contracts,
        token,
        `/${contract.id}/commands`,
        {
          action,
          requestKey: `long-${++sequence}`,
          version: contract.version,
          revision: contract.revision,
          confirmed: true,
          reason,
          ...extra
        }
      );
      if (result.status === 200) contract = result.body.data;
      return result;
    };
    assert.equal(
      (await command(f.buyer, "transition", { to: "pending_confirmation" }))
        .status,
      200
    );
    assert.equal((await command(f.buyer, "confirm")).status, 200);
    assert.equal((await command(f.seller, "confirm")).status, 200);
    assert.equal(contract.status, "active");
    const before = f.contracts.read(f.buyer, contract.id);
    for (const field of ["scope", "deliverables", "acceptance"] as const) {
      const result = await command(f.buyer, "change", {
        terms: { ...original.terms, [field]: original.terms[field] + "超" }
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "INVALID_TEXT");
      assert.deepEqual(f.contracts.read(f.buyer, contract.id), before);
    }
    assert.equal(
      (
        await command(f.seller, "change", {
          terms: { ...original.terms, price: 200 }
        })
      ).status,
      200
    );
    assert.equal(contract.status, "pending_confirmation");
    assert.deepEqual(contract.versions[0], original);
    assert.deepEqual(contract.versions[1]!.terms, {
      ...original.terms,
      price: 200
    });
    assert.equal((await command(f.buyer, "confirm")).status, 200);
    assert.equal(contract.status, "pending_confirmation");
    assert.equal((await command(f.seller, "confirm")).status, 200);
    assert.equal(contract.status, "active");
    assert.equal(contract.version, 2);
    assert.deepEqual(contract.versions[0], original);
    const active = f.contracts.read(f.buyer, contract.id);
    const oversized = await command(f.seller, "change", {
      terms: {
        ...original.terms,
        scope: "超".repeat(Math.floor(contractBodyLimit / 3) + 1)
      }
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, "BODY_TOO_LARGE");
    assert.deepEqual(f.contracts.read(f.buyer, contract.id), active);
  } finally {
    f.db.close();
  }
});
test("both human parties confirm the same version concurrently; retries cannot duplicate transitions", async () => {
  const f = setup();
  try {
    assert.throws(
      () => f.command(f.buyer, "transition", { to: "active" }),
      /INVALID_TRANSITION/
    );
    f.command(f.buyer, "transition", { to: "pending_confirmation" });
    const snapshot = f.current();
    const body = {
      action: "confirm",
      version: snapshot.version,
      revision: snapshot.revision,
      confirmed: true,
      reason,
      requestKey: "concurrent"
    };
    const id = String(snapshot.id);
    const results = await Promise.all(
      [f.buyer, f.seller].map(token =>
        request(f.contracts, token, `/${id}/commands`, body)
      )
    );
    assert.ok(results.every(r => r.status === 200));
    const active = f.contracts.read(f.buyer, id);
    assert.equal(active.status, "active");
    assert.equal(active.confirmations.length, 2);
    assert.equal(
      active.events.filter(e => e.payload.to === "active").length,
      1
    );
    assert.deepEqual(f.contracts.command(f.buyer, id, body), active);
    assert.throws(
      () =>
        f.contracts.command(f.buyer, id, {
          ...body,
          reason: { code: "other", detail: "other" }
        }),
      /REQUEST_KEY_REUSED/
    );
    assert.equal(active.settlement, "unsettled");
  } finally {
    f.db.close();
  }
});
test("scope changes preserve history, invalidate old confirmations and freeze delivery until both reconfirm", () => {
  const f = setup();
  try {
    f.activate();
    const original = f.current();
    const nextTerms = {
      ...original.versions[0]!.terms,
      scope: "新范围",
      price: 200
    };
    f.command(f.seller, "change", { terms: nextTerms });
    assert.equal(f.current().version, 2);
    assert.equal(f.current().status, "pending_confirmation");
    assert.deepEqual(f.current().versions[0], original.versions[0]);
    assert.throws(
      () => f.command(f.buyer, "confirm", { version: 1 }),
      /STALE_CONTRACT/
    );
    assert.throws(
      () =>
        f.command(f.seller, "milestone", {
          milestoneId: original.milestones[0]!.id,
          to: "in_progress"
        }),
      /INVALID_TRANSITION/
    );
    f.command(f.buyer, "confirm");
    assert.equal(f.current().status, "pending_confirmation");
    f.command(f.seller, "confirm");
    assert.equal(f.current().status, "active");
    assert.throws(
      () =>
        f.command(f.seller, "milestone", {
          milestoneId: original.milestones[0]!.id,
          to: "in_progress"
        }),
      ForbiddenError
    );
    assert.throws(
      () => f.db.exec("UPDATE contract_versions SET terms = '{}'"),
      /Immutable/
    );
    assert.throws(
      () => f.db.exec("DELETE FROM contract_versions"),
      /Immutable/
    );
    f.command(f.buyer, "change", { terms: nextTerms });
    assert.equal(f.current().version, 3);
  } finally {
    f.db.close();
  }
});
test("milestone validation, rework and Agent draft are distinct from buyer acceptance and manual settlement", () => {
  const f = setup();
  try {
    f.db.exec(
      "INSERT INTO agents VALUES ('buyer-agent', 'buyer', 'buyer', '[]')"
    );
    const id = String(f.current().id);
    const agent = f.auth.issueAgentToken(
      f.buyer,
      "buyer-agent",
      ["read", "write"].map(action => ({
        kind: "contract",
        resourceId: id,
        action: action as "read" | "write"
      }))
    );
    assert.throws(
      () => f.command(agent, "transition", { to: "pending_confirmation" }),
      ForbiddenError
    );
    f.activate();
    for (const m of f.current().milestones) {
      const milestoneId = m.id;
      assert.throws(
        () => f.command(f.buyer, "milestone", { milestoneId, to: "accepted" }),
        /INVALID_TRANSITION/
      );
      f.command(f.seller, "milestone", { milestoneId, to: "in_progress" });
      assert.throws(
        () =>
          f.command(f.seller, "milestone", { milestoneId, to: "submitted" }),
        /INVALID_TEXT/
      );
      f.command(f.seller, "milestone", {
        milestoneId,
        to: "submitted",
        evidence: "合成离线报告"
      });
      f.command(agent, "review_draft", { milestoneId, report: "建议验收" });
      assert.equal(
        f.current().milestones.find(v => v.id === milestoneId)!.status,
        "submitted"
      );
      assert.throws(
        () => f.command(agent, "milestone", { milestoneId, to: "accepted" }),
        ForbiddenError
      );
      assert.throws(
        () => f.command(f.seller, "milestone", { milestoneId, to: "accepted" }),
        ForbiddenError
      );
      assert.throws(
        () =>
          f.command(f.buyer, "milestone", {
            milestoneId,
            to: "accepted",
            reason: {}
          }),
        /INVALID_TEXT/
      );
      f.command(f.buyer, "milestone", { milestoneId, to: "changes_requested" });
      f.command(f.seller, "milestone", {
        milestoneId,
        to: "submitted",
        evidence: "修改后报告"
      });
      f.command(f.buyer, "milestone", { milestoneId, to: "accepted" });
    }
    f.command(f.buyer, "transition", { to: "completed" });
    assert.equal(f.current().settlement, "unsettled");
    f.command(f.buyer, "settlement");
    assert.equal(f.current().settlement, "manually_confirmed");
    assert.equal(f.current().events.at(-1)!.payload.paymentExecuted, false);
    for (const e of f.current().events) {
      assert.ok(e.actor_id);
      assert.equal(e.created_at, 1000);
      assert.ok(e.payload.reason.code);
    }
  } finally {
    f.db.close();
  }
});
test("disputes freeze all subsequent commands and audit failures roll back state", () => {
  const f = setup();
  try {
    f.activate();
    const before = f.current();
    assert.throws(
      () => f.command(f.buyer, "transition", { to: "completed" }),
      /MILESTONES_NOT_ACCEPTED/
    );
    f.db.exec(
      "CREATE TRIGGER offline_failure BEFORE INSERT ON contract_events BEGIN SELECT RAISE(ABORT, 'offline failure'); END;"
    );
    assert.throws(
      () => f.command(f.buyer, "transition", { to: "paused" }),
      /offline failure/
    );
    assert.deepEqual(f.contracts.read(f.buyer, String(before.id)), before);
    f.db.exec("DROP TRIGGER offline_failure");
    f.command(f.buyer, "transition", { to: "paused" });
    assert.throws(
      () =>
        f.command(f.seller, "milestone", {
          milestoneId: before.milestones[0]!.id,
          to: "in_progress"
        }),
      /INVALID_TRANSITION/
    );
    f.command(f.seller, "transition", { to: "active" });
    f.command(f.buyer, "transition", { to: "disputed" });
    const disputed = f.current();
    for (const action of [
      "transition",
      "change",
      "confirm",
      "milestone",
      "review_draft",
      "settlement"
    ])
      assert.throws(
        () => f.command(f.buyer, action, { to: "active" }),
        /DISPUTE_FROZEN/
      );
    assert.deepEqual(f.contracts.read(f.buyer, String(disputed.id)), disputed);
    assert.throws(() => f.db.exec("DELETE FROM contract_events"), /Immutable/);
  } finally {
    f.db.close();
  }
});
async function request(
  service: Contracts,
  token: string,
  path: string,
  body?: unknown
) {
  const bytes =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 65536)
    chunks.push(bytes.subarray(offset, offset + 65536));
  const stream = Readable.from(chunks) as IncomingMessage;
  stream.url = "/api/contracts" + path;
  stream.method = body === undefined ? "GET" : "POST";
  stream.headers = { "content-type": "application/json" };
  stream.rawHeaders = ["Authorization", "Bearer " + token];
  let output = "";
  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (value: string) => {
      output = value;
    }
  };
  await contractRoute(
    stream,
    (response as unknown) as ServerResponse,
    "offline-request",
    service
  );
  return { status: response.statusCode, body: JSON.parse(output) };
}
test("HTTP selection, confirmation flag, stale writes and uniform authorization errors", async () => {
  const f = setup();
  try {
    assert.equal(
      (
        await request(f.contracts, f.buyer, "/select", {
          bidId: f.bid.id,
          confirmed: true
        })
      ).body.data.id,
      f.current().id
    );
    assert.equal(
      (
        await request(f.contracts, f.buyer, "/select", {
          bidId: f.bid.id,
          confirmed: false
        })
      ).status,
      400
    );
    const outsider = f.auth.issueUserSession("outsider");
    assert.deepEqual(
      await request(f.contracts, outsider, "/" + f.current().id),
      await request(f.contracts, outsider, "/missing")
    );
    assert.throws(
      () =>
        f.command(f.buyer, "transition", {
          to: "pending_confirmation",
          confirmed: false
        }),
      /CONFIRMATION_REQUIRED/
    );
    assert.throws(
      () =>
        f.command(f.buyer, "transition", {
          to: "pending_confirmation",
          revision: 0
        }),
      /STALE_CONTRACT/
    );
    f.command(f.buyer, "transition", { to: "cancelled" });
    assert.throws(
      () => f.command(f.buyer, "transition", { to: "active" }),
      /INVALID_TRANSITION/
    );
  } finally {
    f.db.close();
  }
});

test("independent SQLite workers serialize concurrent confirmations and duplicate requests", async () => {
  const { Worker } = await import("node:worker_threads");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "octo-contract-"));
  const path = join(directory, "concurrent.sqlite");
  const f = setup(path);
  try {
    f.command(f.buyer, "transition", { to: "pending_confirmation" });
    const snapshot = f.current();
    const gate = new SharedArrayBuffer(4);
    const jobs = [f.buyer, f.buyer, f.seller].map(token => {
      const worker = new Worker(
        `
        const { workerData, parentPort } = require('node:worker_threads');
        (async () => {
          const { DatabaseSync } = await import('node:sqlite');
          const { Authorization } = await import(workerData.authUrl);
          const { SqliteIdentityStore } = await import(workerData.identityUrl);
          const { Contracts } = await import(workerData.contractUrl);
          const db = new DatabaseSync(workerData.path);
          db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
          const service = new Contracts(db, new Authorization(new SqliteIdentityStore(db), () => 1000), () => 1000);
          parentPort.postMessage('ready');
          Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          try {
            service.command(workerData.token, workerData.id, workerData.body);
            parentPort.postMessage('done');
          } finally { db.close(); }
        })().catch(error => { throw error; });
      `,
        {
          eval: true,
          workerData: {
            path,
            gate,
            token,
            id: snapshot.id,
            body: {
              action: "confirm",
              version: snapshot.version,
              revision: snapshot.revision,
              requestKey: "parallel-confirm",
              confirmed: true,
              reason
            },
            authUrl: new URL("../packages/auth/src/index.js", import.meta.url)
              .href,
            identityUrl: new URL(
              "../packages/database/src/identity.js",
              import.meta.url
            ).href,
            contractUrl: new URL(
              "../packages/database/src/contracts.js",
              import.meta.url
            ).href
          }
        }
      );
      const ready = new Promise<void>((resolve, reject) => {
        worker.on("message", message => {
          if (message === "ready") resolve();
        });
        worker.on("error", reject);
      });
      const done = new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", code => {
          if (code === 0) resolve();
          else reject(new Error("worker failed"));
        });
      });
      return { worker, ready, done };
    });
    try {
      await Promise.all(jobs.map(job => job.ready));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(jobs.map(job => job.done));
      const result = f.contracts.read(f.buyer, snapshot.id);
      assert.equal(result.status, "active");
      assert.equal(result.confirmations.length, 2);
      assert.equal(
        result.events.filter(e => e.payload.to === "active").length,
        1
      );
    } finally {
      await Promise.all(jobs.map(job => job.worker.terminate()));
    }
  } finally {
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser console loads versions and submits human confirmation through HTTP", async () => {
  const { mountContracts } = await import("../apps/web/src/contracts.js");
  class Element extends EventTarget {
    value = "";
    checked = false;
    textContent = "";
    click() {
      this.dispatchEvent(new Event("click"));
    }
  }
  const elements = new Map<string, Element>();
  for (const id of [
    "session",
    "contract",
    "bid",
    "snapshot",
    "terms",
    "confirmed",
    "load",
    "select",
    "status",
    "transition",
    "confirm",
    "change",
    "milestone-action",
    "review",
    "settlement",
    "reason-code",
    "reason-detail",
    "target",
    "milestone",
    "evidence"
  ])
    elements.set(id, new Element());
  const root = ({
    getElementById: (id: string) => elements.get(id)
  } as unknown) as Document;
  const f = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      } as Response;
    const token = elements.get("session")!.value;
    assert.ok(!url.includes(token));
    const result = await request(
      f.contracts,
      token,
      url.replace("/api/contracts", ""),
      options.body ? JSON.parse(String(options.body)) : undefined
    );
    return { json: async () => result.body } as Response;
  }) as typeof fetch;
  const click = async (id: string) => {
    elements.get(id)!.click();
    for (let i = 0; i < 5; i++)
      await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    mountContracts(root);
    elements.get("session")!.value = f.buyer;
    elements.get("contract")!.value = f.current().id;
    await click("load");
    assert.match(elements.get("snapshot")!.textContent, /draft/);
    elements.get("target")!.value = "pending_confirmation";
    elements.get("reason-code")!.value = "reviewed";
    elements.get("reason-detail")!.value = "人工阅读当前条款";
    await click("transition");
    assert.match(elements.get("status")!.textContent, /CONFIRMATION_REQUIRED/);
    elements.get("confirmed")!.checked = true;
    await click("transition");
    elements.get("confirmed")!.checked = true;
    await click("confirm");
    assert.equal(
      f.contracts.read(f.buyer, f.current().id).status,
      "pending_confirmation"
    );
    elements.get("session")!.value = f.seller;
    elements.get("contract")!.dispatchEvent(new Event("input"));
    assert.equal(elements.get("snapshot")!.textContent, "");
    await click("load");
    elements.get("confirmed")!.checked = true;
    await click("confirm");
    assert.equal(f.contracts.read(f.buyer, f.current().id).status, "active");
  } finally {
    globalThis.fetch = originalFetch;
    f.db.close();
  }
});

test("all forbidden contract and milestone edges reject without changing audit history", () => {
  const f = setup();
  try {
    const id = f.current().id;
    const allowed: Record<string, string[]> = {
      draft: ["pending_confirmation", "cancelled"],
      pending_confirmation: ["cancelled", "disputed"],
      active: ["paused", "completed", "cancelled", "disputed"],
      paused: ["active", "cancelled", "disputed"],
      completed: [],
      cancelled: [],
      disputed: []
    };
    for (const from of Object.keys(allowed)) {
      f.db
        .prepare("UPDATE contracts SET status = ? WHERE id = ?")
        .run(from, id);
      for (const to of [...Object.keys(allowed), "unknown"]) {
        if (allowed[from]!.includes(to)) continue;
        assert.throws(
          () => f.command(f.buyer, "transition", { to }),
          /INVALID_TRANSITION|DISPUTE_FROZEN/
        );
      }
    }
    f.db.prepare("UPDATE contracts SET status = 'active' WHERE id = ?").run(id);
    const milestone = f.current().milestones[0]!;
    const edges: Record<string, string[]> = {
      planned: ["in_progress"],
      in_progress: ["submitted"],
      submitted: ["accepted", "changes_requested", "rejected"],
      changes_requested: ["in_progress", "submitted"],
      accepted: [],
      rejected: []
    };
    for (const from of Object.keys(edges)) {
      f.db
        .prepare("UPDATE milestones SET status = ? WHERE id = ?")
        .run(from, milestone.id!);
      for (const to of [...Object.keys(edges), "unknown"]) {
        if (edges[from]!.includes(to)) continue;
        assert.throws(
          () =>
            f.command(f.buyer, "milestone", { to, milestoneId: milestone.id }),
          /INVALID_TRANSITION/
        );
      }
    }
    assert.equal(f.contracts.read(f.buyer, id).events.length, 1);
    f.db
      .prepare("UPDATE milestones SET status = 'submitted' WHERE id = ?")
      .run(milestone.id!);
    f.command(f.buyer, "milestone", {
      to: "rejected",
      milestoneId: milestone.id
    });
    assert.equal(f.current().milestones[0]!.status, "rejected");
  } finally {
    f.db.close();
  }
});

test("contract Agent scopes and revoked grants are checked on every read and retry", () => {
  const f = setup();
  try {
    const id = f.current().id;
    const unscoped = f.auth.issueAgentToken(f.seller, "agent-a", []);
    assert.throws(() => f.contracts.read(unscoped, id), ForbiddenError);
    const scoped = f.auth.issueAgentToken(f.seller, "agent-a", [
      { kind: "contract", resourceId: id, action: "read" }
    ]);
    assert.equal(f.contracts.read(scoped, id).id, id);
    assert.throws(() => f.command(scoped, "confirm"), ForbiddenError);
    f.db
      .prepare(
        "DELETE FROM resource_grants WHERE user_id = 'seller' AND resource_kind = 'contract' AND resource_id = ? AND action = 'read'"
      )
      .run(id);
    assert.throws(() => f.contracts.read(scoped, id), ForbiddenError);
    assert.throws(() => f.contracts.read(f.seller, id), ForbiddenError);
    assert.equal(f.contracts.read(f.buyer, id).id, id);
  } finally {
    f.db.close();
  }
});

test("party migration preserves legacy contracts, confirmations, workspace and effective grants", () => {
  const f = setup();
  try {
    f.activate();
    const id = f.current().id;
    const before = f.contracts.read(f.buyer, id);
    const grants = f.db.prepare("SELECT * FROM resource_grants").all();
    f.db.exec("DROP VIEW contract_parties");
    f.db.exec(
      readFileSync(
        "packages/database/migrations/0017_contract_parties.sql",
        "utf8"
      )
    );
    assert.deepEqual(f.contracts.read(f.buyer, id), before);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM resource_grants").all(),
      grants
    );
    assert.equal(
      f.auth.authorize(f.seller, {
        kind: "contract",
        resourceId: id,
        action: "delegate"
      }).role,
      "seller"
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM delivery_workspaces WHERE contract_id=?"
        )
        .get(id)!.n,
      1
    );
    f.db.exec("DELETE FROM memberships WHERE user_id='seller'");
    assert.equal(f.contracts.read(f.seller, id).id, id);
  } finally {
    f.db.close();
  }
});
