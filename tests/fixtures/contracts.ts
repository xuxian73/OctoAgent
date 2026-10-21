import { FakeScanner } from "../../packages/security/src/index.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import {
  Authorization,
  ForbiddenError
} from "../../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../../packages/database/src/identity.js";
import { Requirements } from "../../packages/database/src/requirements.js";
import { Market } from "../../packages/database/src/market.js";
import {
  Draft,
  fields,
  contextFields
} from "../../packages/requirements/src/model.js";
import { Proposal } from "../../packages/requirements/src/bids.js";
import { seedIdentities } from "./identity.js";
import {
  Contracts,
  contractBodyLimit
} from "../../packages/database/src/contracts.js";
import { contractRoute } from "../../apps/server/src/contracts.js";
export function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  db.exec(`INSERT INTO users VALUES ('seller-two', 'member');
 INSERT INTO memberships VALUES ('seller-two', 'org-a', '', 'seller'), ('seller-two', 'org-a', 'project-a', 'seller');
 INSERT INTO resource_grants VALUES ('seller-two', 'project', 'project-a', 'read'), ('seller-two', 'project', 'project-a', 'write');`);
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const req = new Requirements(db, auth, () => now, new FakeScanner());
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
    contracts: new Contracts(db, auth, () => now),
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
const reason = { code: "scope", detail: "合成验收原因" };
export function setup(path = ":memory:") {
  const f = fixture(path);
  const task = f.publish();
  const bid = f.submit(f.seller, task);
  let contract = f.contracts.select(f.buyer, bid.id, true);
  let sequence = 0;
  const command = (
    token: string,
    action: string,
    extra: Record<string, unknown> = {}
  ) => {
    contract = f.contracts.command(token, String(contract.id), {
      action,
      requestKey: `test-${++sequence}`,
      version: contract.version,
      revision: contract.revision,
      confirmed: true,
      reason,
      ...extra
    });
    return contract;
  };
  const activate = () => {
    command(f.buyer, "transition", { to: "pending_confirmation" });
    command(f.buyer, "confirm");
    command(f.seller, "confirm");
  };
  return { ...f, task, bid, command, activate, current: () => contract };
}
