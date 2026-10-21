import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { LocalAccounts } from "../packages/database/src/accounts.js";
import { Onboarding } from "../packages/database/src/onboarding.js";
import { Agents } from "../packages/database/src/agents.js";
import { Requirements } from "../packages/database/src/requirements.js";
import { Market } from "../packages/database/src/market.js";
import { Contracts } from "../packages/database/src/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { McpRequests } from "../packages/database/src/mcp.js";
import { MarketplaceMcp } from "../packages/mcp/src/index.js";
import {
  contextFields,
  fields,
  Draft
} from "../packages/requirements/src/model.js";
import {
  requestContext,
  securityContext
} from "../packages/security/src/index.js";

const proposal = {
  summary: "离线方案",
  milestones: ["实现", "验收"],
  hours: 8,
  days: 2,
  price: 100,
  prerequisites: ["无"],
  risks: ["无"],
  risk: "low",
  permissions: ["只读"],
  evidence: ["检查报告"],
  capabilities: ["TypeScript"]
};

async function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const accounts = new LocalAccounts(db);
  const onboarding = new Onboarding(db, auth);
  const users = [];
  for (const name of ["public-buyer", "public-seller", "public-competitor"]) {
    const password = randomBytes(32).toString("base64url");
    await accounts.register(name, password);
    const id = (await accounts.verify(name, password))!;
    users.push({ id, token: auth.issueUserSession(id) });
  }
  const [buyer, seller, competitor] = users as [
    typeof users[number],
    typeof users[number],
    typeof users[number]
  ];
  const project = onboarding.create(buyer.token, {
    role: "buyer",
    organizationName: "测试甲方",
    projectName: "测试项目"
  });
  assert.ok("projectId" in project);
  for (const user of [seller, competitor])
    onboarding.create(user.token, {
      role: "seller",
      displayName: "独立乙方",
      capabilities: "TypeScript",
      taskTypes: "新功能",
      bio: "测试资料"
    });
  const req = new Requirements(db, auth, () => now);
  const market = new Market(db, auth, () => now);
  const agents = new Agents(db, auth);
  const values = Object.fromEntries(
    Object.keys(fields).map(k => [k, "合成需求"])
  );
  Object.assign(values, {
    repository: "PRIVATE_REPOSITORY",
    environment: "PRIVATE_ENVIRONMENT",
    amount: "100",
    currency: "CNY",
    taskType: "新功能",
    budgetType: "固定总价",
    stack: "TypeScript"
  });
  const draft: Draft = {
    values,
    publicFields: contextFields,
    market: {
      deadline: 900000,
      durationDays: 2,
      risk: "low",
      allowAgents: true
    }
  };
  const create = () => req.create(buyer.token, project.projectId!, draft).id;
  const publish = (id: string) =>
    req.publish(
      buyer.token,
      id,
      req.preview(buyer.token, id).confirmation,
      true
    );
  const save = (id: string, input: Draft) =>
    req.save(buyer.token, id, req.read(buyer.token, id).revision, input);
  const mcp = new MarketplaceMcp(
    {
      auth,
      requirements: req,
      market,
      contracts: new Contracts(db, auth, () => now),
      workspaces: new Workspaces(db, auth, () => now),
      requests: new McpRequests(db)
    },
    () => now
  );
  return {
    db,
    auth,
    buyer,
    seller,
    competitor,
    project,
    req,
    market,
    agents,
    draft,
    create,
    publish,
    save,
    mcp,
    advance: () => {
      now = 900001;
    }
  };
}

test("independent registered sellers discover only publications, clarify, confirm bids and receive version notifications without project grants", async () => {
  const f = await setup();
  try {
    const id = f.create();
    assert.deepEqual(f.market.search(f.seller.token, ""), []);
    assert.throws(() => f.market.detail(f.seller.token, id), ForbiddenError);
    f.req.addAttachment(f.buyer.token, id, {
      revision: f.req.read(f.buyer.token, id).revision,
      name: "private.txt",
      mime: "text/plain",
      size: 10
    });
    f.publish(id);
    f.save(id, {
      ...f.draft,
      values: { ...f.draft.values, goal: "UNPUBLISHED_GOAL" }
    });
    const found = f.market.search(f.seller.token, "");
    assert.equal(found.length, 1);
    assert.doesNotMatch(
      JSON.stringify(found),
      /PRIVATE_|UNPUBLISHED|private.txt|project_id|projectId/
    );
    assert.deepEqual(found[0]!.attachments, []);
    const detail = f.market.detail(f.seller.token, id);
    assert.equal(detail.version, 1);
    for (const bad of ["absent", "../" + id, "' OR 1=1 --"])
      assert.throws(() => f.market.detail(f.seller.token, bad), ForbiddenError);
    assert.throws(() => f.req.read(f.seller.token, id), ForbiddenError);
    assert.throws(
      () => f.req.save(f.seller.token, id, 1, f.draft),
      ForbiddenError
    );
    const question = f.market.clarify(f.seller.token, id, "验收", "定向澄清");
    f.market.answer(f.buyer.token, id, question, "定向回复", "需求", "无");
    assert.ok(
      f.market.timeline(f.seller.token, id).some(e => e.kind === "answer")
    );
    assert.deepEqual(f.market.timeline(f.competitor.token, id), []);
    const other = f.create();
    f.publish(other);
    assert.throws(
      () =>
        f.market.answer(f.buyer.token, other, question, "回答", "证据", "无"),
      ForbiddenError
    );
    const bid = f.market.draft(f.seller.token, id, proposal);
    assert.throws(
      () => f.market.bid(f.competitor.token, bid.id),
      ForbiddenError
    );
    assert.throws(
      () => f.market.withdraw(f.competitor.token, bid.id),
      ForbiddenError
    );
    const preview = f.market.preview(f.seller.token, bid.id);
    assert.throws(() =>
      f.market.submit(f.seller.token, bid.id, preview.confirmation, false)
    );
    f.market.submit(f.seller.token, bid.id, preview.confirmation, true);
    assert.equal(f.market.compare(f.buyer.token, id).length, 1);
    f.publish(id);
    assert.equal(f.market.bid(f.seller.token, bid.id).stale, true);
    assert.deepEqual(f.market.compare(f.buyer.token, id), []);
    assert.equal(f.market.notifications(f.seller.token).items.length, 1);
    assert.deepEqual(f.market.notifications(f.competitor.token).items, []);
    f.market.readNotification(f.seller.token, id, 2);
    for (const action of ["read", "write", "delegate"] as const)
      assert.throws(
        () =>
          f.auth.authorize(f.seller.token, {
            kind: "project",
            resourceId: f.project.projectId!,
            action
          }),
        ForbiddenError
      );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM memberships WHERE user_id=? AND project_id != ''"
        )
        .get(f.seller.id)!.n,
      0
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM resource_grants WHERE user_id=? AND resource_kind='project'"
        )
        .get(f.seller.id)!.n,
      0
    );
    f.advance();
    assert.throws(() => f.req.publicView(id), /NOT_FOUND/);
    assert.deepEqual(f.market.search(f.seller.token, ""), []);
    assert.throws(() => f.market.detail(f.seller.token, id), ForbiddenError);
    assert.throws(() => f.market.draft(f.seller.token, id, proposal));
    assert.equal(f.market.withdraw(f.seller.token, bid.id).status, "withdrawn");
  } finally {
    f.db.close();
  }
});

test("task scopes, responsible principals, visibility and participation revocation are rechecked on ordinary requests and replay", async () => {
  const f = await setup();
  try {
    const id = f.create();
    f.publish(id);
    const other = f.create();
    f.publish(other);
    const agent = f.agents.create(f.seller.token, {
      kind: "seller",
      capabilities: ["TypeScript"]
    });
    const empty = f.auth.issueAgentToken(f.seller.token, agent.id);
    const search = f.auth.issueAgentToken(f.seller.token, agent.id, [
      { kind: "market", resourceId: "public", action: "read" }
    ]);
    const scopes = (["read", "write"] as const).map(action => ({
      kind: "task" as const,
      resourceId: id,
      action
    }));
    const token = f.auth.issueAgentToken(f.seller.token, agent.id, scopes);
    const call = (
      credential: string,
      name: string,
      args: Record<string, unknown>
    ) => f.mcp.call(credential, name, args);
    assert.equal(
      call(empty, "search_tasks", { request_id: "empty-search" }).error?.code,
      "FORBIDDEN"
    );
    assert.equal(
      (call(search, "search_tasks", { request_id: "public-search" })
        .data as unknown[]).length,
      2
    );
    assert.equal(
      call(search, "get_task_context", {
        request_id: "search-is-not-task",
        task_id: id
      }).error?.code,
      "FORBIDDEN"
    );
    assert.equal(
      call(token, "get_task_context", {
        request_id: "wrong-task",
        task_id: other
      }).error?.code,
      "FORBIDDEN"
    );
    assert.equal(
      f.mcp.resource(token, "octo://task/" + id).status,
      "published"
    );
    assert.equal(
      f.mcp.resource(token, "octo://task/" + other).error?.code,
      "FORBIDDEN"
    );
    const args = { request_id: "draft-once", task_id: id, proposal };
    const result = call(token, "draft_bid", args);
    assert.equal(result.error, undefined);
    const bid = (result.data as { id: string }).id;
    const submit = call(token, "submit_bid", {
      request_id: "submit-confirmation",
      bid_id: bid
    });
    assert.equal(submit.requires_human_confirmation, true);
    assert.equal(f.market.bid(f.seller.token, bid).status, "draft");
    assert.throws(
      () => f.market.submit(token, bid, "forged", true),
      ForbiddenError
    );
    const readOnly = f.auth.issueAgentToken(
      f.seller.token,
      agent.id,
      scopes.slice(0, 1)
    );
    assert.equal(
      call(readOnly, "draft_bid", { ...args, request_id: "readonly" }).error
        ?.code,
      "FORBIDDEN"
    );
    assert.equal(call(token, "draft_bid", args).error, undefined);
    const replay = () =>
      securityContext.run(requestContext("replay", "clarify-once"), () =>
        f.market.clarify(f.seller.token, id, "范围", "问题")
      );
    const question = replay();
    assert.equal(replay(), question);
    f.db
      .prepare(
        "UPDATE market_participations SET revoked=1 WHERE requirement_id=? AND user_id=?"
      )
      .run(id, f.seller.id);
    assert.throws(replay, ForbiddenError);
    assert.throws(() => f.market.detail(f.seller.token, id), ForbiddenError);
    assert.equal(call(token, "draft_bid", args).error?.code, "FORBIDDEN");
    assert.equal(
      call(search, "search_tasks", { request_id: "public-search" }).error?.code,
      "FORBIDDEN"
    );
    f.db
      .prepare(
        "UPDATE market_participations SET revoked=0 WHERE requirement_id=? AND user_id=?"
      )
      .run(id, f.seller.id);
    f.save(id, {
      ...f.draft,
      market: { ...f.draft.market!, allowAgents: false }
    });
    f.publish(id);
    assert.equal(call(token, "draft_bid", args).error?.code, "FORBIDDEN");
    f.save(id, { values: f.draft.values, publicFields: [] });
    f.publish(id);
    assert.throws(replay, ForbiddenError);
    assert.throws(() => f.req.publicView(id), /NOT_FOUND/);
    assert.throws(() => f.market.detail(f.seller.token, id), ForbiddenError);
    assert.equal(
      f.market.search(f.seller.token, "").some(t => t.id === id),
      false
    );
    f.db.exec("PRAGMA foreign_keys=OFF");
    f.db.prepare("DELETE FROM users WHERE id=?").run(f.seller.id);
    assert.equal(
      call(search, "search_tasks", { request_id: "no-owner" }).error?.code,
      "FORBIDDEN"
    );
  } finally {
    f.db.close();
  }
});
