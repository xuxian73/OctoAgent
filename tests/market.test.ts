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
import { marketRoute } from "../apps/server/src/market.js";
import { renderMarket, renderComparison } from "../apps/web/src/market.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  db.exec(`INSERT INTO users VALUES ('seller-two', 'member');
 INSERT INTO memberships VALUES ('seller-two', 'org-a', '', 'seller'), ('seller-two', 'org-a', 'project-a', 'seller');
 INSERT INTO resource_grants VALUES ('seller-two', 'project', 'project-a', 'read'), ('seller-two', 'project', 'project-a', 'write');`);
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const req = new Requirements(db, auth, () => now);
  const market = new Market(db, auth, () => now);
  const buyer = auth.issueUserSession("buyer");
  const seller = auth.issueUserSession("seller");
  const second = auth.issueUserSession("seller-two");
  const values = Object.fromEntries(
    Object.keys(fields).map(k => [k, "合成需求"])
  );
  Object.assign(values, {
    stack: "TypeScript testing",
    taskType: "新功能",
    budgetType: "固定总价",
    amount: "100",
    currency: "CNY"
  });
  const draft: Draft = {
    values,
    publicFields: contextFields,
    market: {
      deadline: 900000,
      durationDays: 14,
      risk: "low",
      allowAgents: true
    }
  };
  function publish(input = draft) {
    const task = req.create(buyer, "project-a", input);
    req.publish(buyer, task.id, req.preview(buyer, task.id).confirmation, true);
    return task.id;
  }
  function submit(token: string, id: string, proposal = offer) {
    const bid = market.draft(token, id, proposal);
    const preview = market.preview(token, bid.id);
    return market.submit(token, bid.id, preview.confirmation, true);
  }
  return {
    db,
    auth,
    req,
    market,
    buyer,
    seller,
    second,
    draft,
    publish,
    submit,
    advance: (delta: number) => {
      now += delta;
    }
  };
}
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

test("discovery filters only published, authorized and open snapshots; private context stays hidden", () => {
  const f = fixture();
  try {
    f.req.create(f.buyer, "project-a", f.draft);
    const id = f.publish();
    f.publish({ ...f.draft, market: undefined });
    const deniedAgent = f.auth.issueAgentToken(f.seller, "agent-a", []);
    assert.throws(
      () => f.market.search(deniedAgent, "project-a"),
      ForbiddenError
    );
    const agent = f.auth.issueAgentToken(f.seller, "agent-a", [
      { kind: "project", resourceId: "project-a", action: "read" }
    ]);
    const noAgent = f.publish({
      ...f.draft,
      market: { ...f.draft.market!, allowAgents: false }
    });
    assert.deepEqual(
      f.market.search(agent, "project-a").map(t => t.id),
      [id]
    );
    assert.throws(() => f.market.detail(agent, noAgent), ForbiddenError);
    const all = {
      stack: "typescript",
      taskType: "新功能",
      budgetType: "固定总价",
      maxDays: "14",
      risk: "low",
      allowAgents: "true",
      deadlineAfter: "2000"
    };
    assert.equal(f.market.search(f.seller, "project-a", all).length, 1);
    for (const [key, value] of Object.entries({
      stack: "Rust",
      taskType: "部署",
      budgetType: "按小时",
      maxDays: "13",
      risk: "high",
      deadlineAfter: "900001"
    }))
      assert.equal(
        f.market.search(f.seller, "project-a", { ...all, [key]: value }).length,
        0
      );
    assert.throws(
      () => f.market.search(f.seller, "project-a", { maxDays: "NaN" }),
      /INVALID_FILTER/
    );
    const before = f.market.detail(f.seller, id);
    assert.equal(before.values.repository, undefined);
    assert.ok(before.values.acceptance);
    assert.deepEqual(before.attachments, []);
    const current = f.req.read(f.buyer, id);
    f.req.save(f.buyer, id, current.revision, {
      ...f.draft,
      values: { ...f.draft.values, goal: "未发布" }
    });
    assert.equal(f.market.detail(f.seller, id).values.goal, before.values.goal);
    for (const user of ["outsider", "admin"]) {
      const token = f.auth.issueUserSession(user);
      for (const target of [id, "absent"])
        assert.throws(() => f.market.detail(token, target), ForbiddenError);
    }
    f.advance(899000);
    assert.deepEqual(f.market.search(f.seller, "project-a"), []);
    assert.throws(() => f.market.draft(f.seller, id, offer), /BIDDING_CLOSED/);
  } finally {
    f.db.close();
  }
});

test("agent drafts require the responsible human; submission retries are atomic and versions remain traceable", () => {
  const f = fixture();
  try {
    const id = f.publish();
    const agent = f.auth.issueAgentToken(
      f.seller,
      "agent-a",
      ["read", "write"].map(action => ({
        kind: "project" as const,
        resourceId: "project-a",
        action: action as "read" | "write"
      }))
    );
    const bid = f.market.draft(agent, id, offer);
    assert.throws(() => f.market.preview(agent, bid.id), ForbiddenError);
    assert.throws(() => f.market.preview(f.second, bid.id), ForbiddenError);
    assert.throws(() => f.market.bid(f.buyer, bid.id), ForbiddenError);
    assert.throws(
      () => f.market.withdraw(f.seller, bid.id),
      /BID_NOT_SUBMITTED/
    );
    const proof = f.market.preview(f.seller, bid.id);
    assert.throws(
      () => f.market.submit(agent, bid.id, proof.confirmation, true),
      ForbiddenError
    );
    assert.throws(
      () => f.market.submit(f.seller, bid.id, proof.confirmation, false),
      /CONFIRMATION_REQUIRED/
    );
    f.db.exec(
      "CREATE TRIGGER reject_event BEFORE INSERT ON market_events BEGIN SELECT RAISE(ABORT, 'offline failure'); END;"
    );
    assert.throws(
      () => f.market.submit(f.seller, bid.id, proof.confirmation, true),
      /offline failure/
    );
    assert.equal(f.market.bid(f.seller, bid.id).status, "draft");
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM requirement_participants").get()!.n,
      0
    );
    f.db.exec("DROP TRIGGER reject_event");
    const submitted = f.market.submit(
      f.seller,
      bid.id,
      proof.confirmation,
      true
    );
    assert.deepEqual(
      f.market.submit(f.seller, bid.id, proof.confirmation, true),
      submitted
    );
    assert.equal(
      f.market.timeline(f.buyer, id).filter(e => e.kind === "bid_submitted")
        .length,
      1
    );
    const next = f.market.draft(f.seller, id, { ...offer, price: 200 });
    const nextProof = f.market.preview(f.seller, next.id);
    f.market.submit(f.seller, next.id, nextProof.confirmation, true);
    assert.equal(next.version, 2);
    f.market.supplement(agent, next.id, "补充证据说明");
    f.market.withdraw(agent, next.id);
    f.market.withdraw(agent, next.id);
    assert.deepEqual(f.market.compare(f.buyer, id), []);
    assert.equal(f.market.listBids(f.buyer, id).length, 2);
    assert.throws(
      () => f.market.submit(f.seller, next.id, nextProof.confirmation, true),
      /STALE_CONFIRMATION/
    );
  } finally {
    f.db.close();
  }
});

test("confirmation expires and published requirement changes require a new bid version", () => {
  const f = fixture();
  try {
    const id = f.publish();
    const bid = f.market.draft(f.seller, id, offer);
    const proof = f.market.preview(f.seller, bid.id);
    f.advance(600000);
    assert.throws(
      () => f.market.submit(f.seller, bid.id, proof.confirmation, true),
      /STALE_CONFIRMATION/
    );
    const fresh = f.market.preview(f.seller, bid.id);
    const task = f.req.read(f.buyer, id);
    f.req.save(f.buyer, id, task.revision, {
      ...f.draft,
      values: { ...f.draft.values, goal: "新范围" }
    });
    f.req.publish(f.buyer, id, f.req.preview(f.buyer, id).confirmation, true);
    assert.throws(
      () => f.market.submit(f.seller, bid.id, fresh.confirmation, true),
      /STALE_CONFIRMATION/
    );
    assert.equal(f.submit(f.seller, id).task_version, 2);
    const edited = f.req.read(f.buyer, id);
    f.req.save(f.buyer, id, edited.revision, f.draft);
    f.req.publish(f.buyer, id, f.req.preview(f.buyer, id).confirmation, true);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM requirement_notifications").get()!.n,
      1
    );
  } finally {
    f.db.close();
  }
});

test("published scope changes exclude old bids until a new version is confirmed", () => {
  const f = fixture();
  try {
    const id = f.publish();
    const first = f.submit(f.seller, id);
    const second = f.submit(f.second, id);
    const task = f.req.read(f.buyer, id);
    f.req.save(f.buyer, id, task.revision, {
      ...f.draft,
      values: { ...f.draft.values, goal: "新的交付范围" }
    });
    assert.equal(f.market.compare(f.buyer, id).length, 2);
    f.req.publish(f.buyer, id, f.req.preview(f.buyer, id).confirmation, true);
    for (const sort of ["risk", "days", "capabilities", "price"])
      assert.deepEqual(f.market.compare(f.buyer, id, sort), []);
    const history = f.market.listBids(f.buyer, id);
    assert.deepEqual(
      new Set(history.map(b => b.id)),
      new Set([first.id, second.id])
    );
    assert.ok(
      history.every(
        b => b.task_version === 1 && b.stale && b.status === "submitted"
      )
    );
    const next = f.market.draft(f.seller, id, offer);
    assert.equal(next.task_version, 2);
    assert.deepEqual(f.market.compare(f.buyer, id), []);
    const proof = f.market.preview(f.seller, next.id);
    f.market.submit(f.seller, next.id, proof.confirmation, true);
    assert.deepEqual(
      f.market.compare(f.buyer, id).map(b => b.id),
      [next.id]
    );
    assert.equal(f.market.bid(f.buyer, next.id).stale, false);
    assert.equal(f.market.listBids(f.buyer, id).length, 3);
    f.market.withdraw(f.seller, next.id);
    assert.deepEqual(f.market.compare(f.buyer, id), []);
  } finally {
    f.db.close();
  }
});

test("comparison supports two bidders and never defaults to cheapest; cross-bid reads deny uniformly", () => {
  const f = fixture();
  try {
    const id = f.publish();
    const first = f.submit(f.seller, id, { ...offer, price: 200 });
    const second = f.submit(f.second, id, {
      ...offer,
      price: 50,
      risk: "high",
      days: 5,
      capabilities: ["testing"]
    });
    assert.deepEqual(
      f.market.compare(f.buyer, id).map(b => b.id),
      [first.id, second.id]
    );
    assert.equal(f.market.compare(f.buyer, id, "days")[0]!.id, second.id);
    assert.equal(
      f.market.compare(f.buyer, id, "capabilities")[0]!.id,
      first.id
    );
    assert.equal(f.market.compare(f.buyer, id, "price")[0]!.id, second.id);
    assert.throws(() => f.market.compare(f.seller, id), ForbiddenError);
    for (const target of [second.id, "absent"])
      assert.throws(() => f.market.bid(f.seller, target), ForbiddenError);
    const attachment = f.req.addAttachment(f.buyer, id, {
      revision: f.req.read(f.buyer, id).revision,
      name: "fixture.txt",
      mime: "text/plain",
      size: 10
    });
    for (const target of [attachment.id, "absent"])
      assert.throws(
        () => f.req.attachment(f.seller, id, target),
        ForbiddenError
      );
    assert.deepEqual(f.market.detail(f.seller, id).attachments, []);
  } finally {
    f.db.close();
  }
});

test("clarifications enforce participants and audience, with stable timeline order and immutable scope", () => {
  const f = fixture();
  try {
    const id = f.publish();
    f.submit(f.seller, id);
    const before = f.req.read(f.buyer, id);
    const targeted = f.market.question(
      f.buyer,
      id,
      "seller",
      "风险",
      "说明风险"
    );
    const broadcast = f.market.question(f.buyer, id, "all", "证据", "说明证据");
    assert.throws(
      () => f.market.answer(f.second, id, broadcast, "回答", "证据", "无"),
      ForbiddenError
    );
    f.submit(f.second, id);
    assert.throws(
      () => f.market.answer(f.second, id, targeted, "回答", "证据", "无"),
      ForbiddenError
    );
    assert.throws(
      () => f.market.question(f.seller, id, "all", "主题", "问题"),
      ForbiddenError
    );
    assert.throws(
      () => f.market.question(f.buyer, id, "outsider", "主题", "问题"),
      ForbiddenError
    );
    const answer = f.market.answer(
      f.seller,
      id,
      broadcast,
      "合成回答",
      "离线证据",
      "需新版本确认"
    );
    assert.ok(f.market.timeline(f.buyer, id).some(e => e.sequence === answer));
    assert.ok(
      !f.market
        .timeline(f.second, id)
        .some(e => e.sequence === answer || e.sequence === targeted)
    );
    const events = f.market.timeline(f.buyer, id);
    assert.deepEqual(
      events.map(e => e.sequence),
      events.map(e => e.sequence).sort((a, b) => a - b)
    );
    assert.deepEqual(f.req.read(f.buyer, id), before);
    f.db.exec(
      "DELETE FROM resource_grants WHERE user_id = 'seller' AND action = 'read'"
    );
    assert.throws(() => f.market.timeline(f.seller, id), ForbiddenError);
  } finally {
    f.db.close();
  }
});

async function request(
  service: Market,
  token: string,
  path: string,
  body?: unknown
) {
  const stream = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)]
  ) as IncomingMessage;
  stream.url = "/api/market" + path;
  stream.method = body === undefined ? "GET" : "POST";
  stream.headers = { "content-type": "application/json" };
  stream.rawHeaders = ["Authorization", "Bearer " + token];
  let output = "";
  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (v: string) => {
      output = v;
    }
  };
  await marketRoute(
    stream,
    (response as unknown) as ServerResponse,
    "offline-request",
    service
  );
  return { status: response.statusCode, body: JSON.parse(output) };
}
test("offline HTTP covers discovery, confirmation, comparison and clarification with uniform errors", async () => {
  const f = fixture();
  try {
    const id = f.publish();
    assert.equal(
      (await request(f.market, f.seller, "?projectId=project-a")).body.data
        .length,
      1
    );
    const draft = await request(f.market, f.seller, `/${id}/bids`, {
      proposal: offer
    });
    const bid = draft.body.data.id;
    const preview = await request(
      f.market,
      f.seller,
      `/bids/${bid}/preview`,
      {}
    );
    assert.equal(
      (
        await request(f.market, f.seller, `/bids/${bid}/submit`, {
          confirmation: preview.body.data.confirmation,
          confirmed: true
        })
      ).status,
      200
    );
    f.submit(f.second, id);
    assert.equal(
      (await request(f.market, f.buyer, `/${id}/compare`)).body.data.length,
      2
    );
    const question = await request(f.market, f.buyer, `/${id}/questions`, {
      recipient: "all",
      topic: "主题",
      text: "问题"
    });
    assert.equal(
      (
        await request(f.market, f.seller, `/${id}/answers`, {
          questionId: question.body.data,
          answer: "回答",
          evidence: "证据",
          impact: "无"
        })
      ).status,
      200
    );
    assert.equal(
      (
        await request(f.market, f.seller, `/bids/${bid}/supplements`, {
          text: "说明"
        })
      ).status,
      200
    );
    assert.equal(
      (await request(f.market, f.seller, `/bids/${bid}/withdraw`, {})).status,
      200
    );
    assert.equal(
      (await request(f.market, f.seller, `/${id}/timeline`)).status,
      200
    );
    const outsider = f.auth.issueUserSession("outsider");
    assert.deepEqual(
      await request(f.market, outsider, `/${id}`),
      await request(f.market, outsider, "/absent")
    );
    assert.equal(
      (
        await request(f.market, f.seller, `/${id}/bids`, {
          proposal: { ...offer, price: -1 }
        })
      ).status,
      400
    );
  } finally {
    f.db.close();
  }
});

test("comparison renders separate columns, evidence and permission rows as text", () => {
  class Element {
    textContent = "";
    children: Element[] = [];
    append(...nodes: Element[]) {
      this.children.push(...nodes);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const root = ({ createElement: () => new Element() } as unknown) as Document;
  const container = new Element();
  renderComparison(root, (container as unknown) as HTMLElement, [
    { owner_id: "seller", version: 1, task_version: 2, proposal: offer },
    {
      owner_id: "seller-two",
      version: 1,
      task_version: 2,
      proposal: { ...offer, summary: "<script>untrusted</script>" }
    }
  ]);
  const rows = container.children[0]!.children;
  assert.ok(rows.every(r => r.children.length === 3));
  assert.match(rows[0]!.children[1]!.textContent, /需求版本 2/);
  assert.equal(rows[1]!.children[2]!.textContent, "<script>untrusted</script>");
  assert.ok(rows.some(r => r.children[0]!.textContent === "访问权限需求"));
  assert.ok(rows.some(r => r.children[0]!.textContent === "可交付证据"));
  const html = renderMarket();
  for (const id of [
    "search",
    "draft",
    "preview",
    "submit",
    "withdraw",
    "compare",
    "ask",
    "answer-question"
  ])
    assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /id="session"/);
});

test("market browser controls submit a confirmed bid and render two comparison columns through HTTP", async () => {
  const { mountMarket } = await import("../apps/web/src/market.js");
  class Element extends EventTarget {
    value = "";
    checked = false;
    textContent = "";
    children: Element[] = [];
    append(...nodes: Element[]) {
      this.children.push(...nodes);
    }
    replaceChildren() {
      this.children = [];
    }
    click() {
      this.dispatchEvent(new Event("click"));
    }
  }
  const elements = new Map<string, Element>();
  for (const id of [
    "session",
    "project",
    "task",
    "bid",
    "summary",
    "confirmed",
    "status",
    "context",
    "results",
    "versions",
    "comparison",
    "stack",
    "taskType",
    "budgetType",
    "maxDays",
    "risk",
    "allowAgents",
    "sort",
    "supplement",
    "recipient",
    "topic",
    "question",
    "question-id",
    "answer",
    "evidence",
    "impact",
    "search",
    "detail",
    "draft",
    "preview",
    "submit",
    "withdraw",
    "add-supplement",
    "history",
    "compare",
    "ask",
    "answer-question",
    ...Object.keys(offer).map(k => "bid-" + k)
  ])
    elements.set(id, new Element());
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Element()
  } as unknown) as Document;
  const f = fixture();
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      } as Response;
    urls.push(url);
    const response = await request(
      f.market,
      elements.get("session")!.value,
      url.replace("/api/market", ""),
      options.body ? JSON.parse(String(options.body)) : undefined
    );
    return { json: async () => response.body } as Response;
  }) as typeof fetch;
  async function click(id: string) {
    elements.get(id)!.click();
    for (let i = 0; i < 5; i++)
      await new Promise<void>(resolve => setImmediate(resolve));
  }
  try {
    const id = f.publish();
    elements.get("session")!.value = f.seller;
    elements.get("project")!.value = "project-a";
    elements.get("task")!.value = id;
    for (const [key, value] of Object.entries(offer))
      elements.get("bid-" + key)!.value = Array.isArray(value)
        ? value.join("\n")
        : String(value);
    mountMarket(root);
    await click("search");
    assert.equal(elements.get("results")!.children.length, 1);
    await click("detail");
    assert.ok(
      elements
        .get("context")!
        .children.some(e => e.textContent.startsWith("报价截止时间"))
    );
    await click("draft");
    const bid = elements.get("bid")!.value;
    assert.ok(bid);
    await click("preview");
    assert.match(elements.get("summary")!.textContent, /可验证交付/);
    await click("submit");
    assert.equal(f.market.bid(f.seller, bid).status, "draft");
    elements.get("confirmed")!.checked = true;
    await click("submit");
    assert.equal(f.market.bid(f.seller, bid).status, "submitted");
    f.submit(f.second, id);
    elements.get("session")!.value = f.buyer;
    elements.get("session")!.dispatchEvent(new Event("input"));
    elements.get("sort")!.value = "risk";
    await click("compare");
    assert.equal(
      elements.get("comparison")!.children[0]!.children[0]!.children.length,
      3
    );
    assert.ok(
      urls.every(url => !url.includes(f.seller) && !url.includes(f.buyer))
    );
  } finally {
    globalThis.fetch = original;
    f.db.close();
  }
});

test("bid audit identifies generated and changed bids independently of the project scope", () => {
  const f = fixture();
  try {
    const task = f.publish();
    const first = f.market.draft(f.seller, task, offer);
    const second = f.market.draft(f.seller, task, offer);
    const drafted = f.db
      .prepare(
        "SELECT * FROM audit_events WHERE event='Market.draft' ORDER BY sequence"
      )
      .all();
    assert.deepEqual(
      drafted.map(e => [e.object_type, e.object_id]),
      [
        ["bid", first.id],
        ["bid", second.id]
      ]
    );
    const preview = f.market.preview(f.seller, second.id);
    f.market.submit(f.seller, second.id, preview.confirmation, true);
    f.market.withdraw(f.seller, second.id);
    for (const event of f.db
      .prepare(
        "SELECT * FROM audit_events WHERE event IN ('Market.preview','Market.submit','Market.withdraw')"
      )
      .all()) {
      assert.equal(event.object_type, "bid");
      assert.equal(event.object_id, second.id);
      assert.ok(
        JSON.parse(String(event.scope)).every(
          (s: { resourceId: string }) => s.resourceId === "project-a"
        )
      );
    }
  } finally {
    f.db.close();
  }
});
