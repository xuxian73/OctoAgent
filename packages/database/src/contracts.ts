import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { Market } from "./market.js";

export interface Terms {
  scope: string;
  deliverables: string;
  acceptance: string;
  changeRules: string;
  price: number;
  currency: "CNY";
  milestones: string[];
}
// Composite terms must retain every legal source field, including separators.
const scopeLimit = 4 * 10000 + "\n\n权限：\n范围排除：".length;
const deliverablesLimit = 10000 + 100 * (10000 + 1);
function text(value: unknown, maxLength = 10000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new RequirementError("INVALID_TEXT");
  return value.trim();
}
function terms(input: unknown): Terms {
  const t = input as Terms;
  if (
    !t ||
    t.currency !== "CNY" ||
    typeof t.price !== "number" ||
    !Number.isFinite(t.price) ||
    t.price <= 0 ||
    t.price > 1e9 ||
    !Array.isArray(t.milestones) ||
    !t.milestones.length ||
    t.milestones.length > 100
  )
    throw new RequirementError("INVALID_TERMS");
  return {
    scope: text(t.scope, scopeLimit),
    deliverables: text(t.deliverables, deliverablesLimit),
    acceptance: text(t.acceptance),
    changeRules: text(t.changeRules),
    price: t.price,
    currency: "CNY",
    milestones: t.milestones.map(value => text(value))
  };
}
const contractEdges: Record<string, readonly string[]> = {
  draft: ["pending_confirmation", "cancelled"],
  pending_confirmation: ["cancelled", "disputed"],
  active: ["paused", "completed", "cancelled", "disputed"],
  paused: ["active", "cancelled", "disputed"],
  completed: [],
  cancelled: [],
  disputed: []
};
const milestoneEdges: Record<string, readonly string[]> = {
  planned: ["in_progress"],
  in_progress: ["submitted"],
  submitted: ["accepted", "changes_requested", "rejected"],
  changes_requested: ["in_progress", "submitted"],
  accepted: [],
  rejected: []
};
export class Contracts {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now
  ) {}
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private access(token: string, id: string, write = false) {
    const row = this.db.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
    if (!row) throw new ForbiddenError();
    const access = this.auth.authorize(
      token,
      { kind: "contract", resourceId: id, action: "read" },
      ["buyer", "seller"]
    );
    if (write)
      this.auth.authorize(
        token,
        { kind: "contract", resourceId: id, action: "write" },
        ["buyer", "seller"]
      );
    const user = access.identity.responsibleUserId;
    const party =
      user === row.buyer_id
        ? "buyer"
        : user === row.seller_id
        ? "seller"
        : undefined;
    if (!party || party !== access.role) throw new ForbiddenError();
    return { row, ...access, party };
  }
  private event(
    id: string,
    version: number,
    actor: string,
    kind: string,
    payload: unknown
  ) {
    this.db
      .prepare(
        "INSERT INTO contract_events (contract_id, version, actor_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, version, actor, this.now(), kind, JSON.stringify(payload));
  }
  private addVersion(id: string, version: number, value: Terms) {
    this.db
      .prepare("INSERT INTO contract_versions VALUES (?, ?, ?)")
      .run(id, version, JSON.stringify(value));
    for (const title of value.milestones)
      this.db
        .prepare("INSERT INTO milestones VALUES (?, ?, ?, ?, 'planned')")
        .run(randomUUID(), id, version, title);
  }
  select(token: string, bidId: string, confirmed: unknown) {
    return this.transaction(() => {
      const market = new Market(this.db, this.auth, this.now);
      const bid = market.bid(token, bidId);
      const task = this.db
        .prepare("SELECT * FROM requirements WHERE id = ?")
        .get(bid.requirement_id)!;
      const access = this.auth.authorize(
        token,
        {
          kind: "project",
          resourceId: String(task.project_id),
          action: "write"
        },
        ["buyer"]
      );
      if (access.identity.kind !== "user") throw new ForbiddenError();
      if (confirmed !== true)
        throw new RequirementError("CONFIRMATION_REQUIRED");
      const existing = this.db
        .prepare("SELECT id, bid_id FROM contracts WHERE requirement_id = ?")
        .get(bid.requirement_id);
      if (existing) {
        if (existing.bid_id !== bidId)
          throw new RequirementError("BID_ALREADY_SELECTED", 409);
        return this.read(token, String(existing.id));
      }
      if (!market.compare(token, bid.requirement_id).some(b => b.id === bidId))
        throw new RequirementError("STALE_BID", 409);
      const published = market.detail(token, bid.requirement_id);
      const value = terms({
        scope:
          String(published.values.goal) +
          "\n" +
          bid.proposal.summary +
          "\n权限：" +
          published.values.permissions +
          "\n范围排除：" +
          published.values.exclusions,
        deliverables:
          published.values.deliverables +
          "\n" +
          bid.proposal.evidence.join("\n"),
        acceptance: published.values.acceptance,
        changeRules: "任一方提出范围变更，生成新版本，双方人工重新确认后生效。",
        price: bid.proposal.price,
        currency: "CNY",
        milestones: bid.proposal.milestones
      });
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO contracts (id, requirement_id, bid_id, buyer_id, seller_id, version, revision, status) VALUES (?, ?, ?, ?, ?, 1, 1, 'draft')"
        )
        .run(id, bid.requirement_id, bidId, access.identity.id, bid.owner_id);
      this.db
        .prepare(
          "INSERT INTO authorization_resources VALUES ('contract', ?, ?, ?)"
        )
        .run(id, access.resource.organizationId, access.resource.id);
      for (const user of [access.identity.id, bid.owner_id])
        for (const action of ["read", "write", "delegate"])
          this.db
            .prepare("INSERT INTO resource_grants VALUES (?, 'contract', ?, ?)")
            .run(user, id, action);
      this.addVersion(id, 1, value);
      this.event(id, 1, access.identity.id, "selected", {
        from: null,
        to: "draft",
        reason: { code: "bid_selected", detail: "甲方确认选定报价" },
        bidId,
        bidVersion: bid.version,
        taskVersion: bid.task_version,
        proposal: bid.proposal,
        requirement: published.values,
        organizationId: access.resource.organizationId
      });
      return this.read(token, id);
    });
  }
  read(token: string, id: string) {
    const { row } = this.access(token, id);
    return {
      ...row,
      id: String(row.id),
      version: Number(row.version),
      revision: Number(row.revision),
      status: String(row.status),
      settlement: String(row.settlement),
      versions: this.db
        .prepare(
          "SELECT * FROM contract_versions WHERE contract_id = ? ORDER BY version"
        )
        .all(id)
        .map(v => ({
          version: Number(v.version),
          terms: JSON.parse(String(v.terms)) as Terms
        })),
      milestones: this.db
        .prepare(
          "SELECT * FROM milestones WHERE contract_id = ? ORDER BY version, rowid"
        )
        .all(id),
      confirmations: this.db
        .prepare(
          "SELECT * FROM contract_confirmations WHERE contract_id = ? ORDER BY version, party"
        )
        .all(id),
      events: this.db
        .prepare(
          "SELECT * FROM contract_events WHERE contract_id = ? ORDER BY sequence"
        )
        .all(id)
        .map(e => ({
          ...e,
          actor_id: String(e.actor_id),
          created_at: Number(e.created_at),
          payload: JSON.parse(String(e.payload))
        }))
    };
  }
  // Every command is bound to the displayed version/revision. Retries cannot apply to a later version.
  command(token: string, id: string, input: Record<string, unknown>) {
    return this.transaction(() => {
      const { row, identity, party } = this.access(token, id, true);
      const action = text(input.action);
      if (action !== "review_draft" && identity.kind !== "user")
        throw new ForbiddenError();
      if (action === "review_draft" && party !== "buyer")
        throw new ForbiddenError();
      const key = text(input.requestKey);
      const fingerprint = JSON.stringify(input);
      const prior = this.db
        .prepare(
          "SELECT fingerprint FROM contract_requests WHERE contract_id = ? AND actor_id = ? AND request_key = ?"
        )
        .get(id, identity.id, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new RequirementError("REQUEST_KEY_REUSED", 409);
        return this.read(token, id);
      }
      if (row.status === "disputed")
        throw new RequirementError("DISPUTE_FROZEN", 409);
      if (
        input.version !== row.version ||
        (action !== "confirm" && input.revision !== row.revision)
      )
        throw new RequirementError("STALE_CONTRACT", 409);
      if (action !== "review_draft" && input.confirmed !== true)
        throw new RequirementError("CONFIRMATION_REQUIRED");
      const reasonInput = input.reason as
        | { code?: unknown; detail?: unknown }
        | undefined;
      const reason = {
        code: text(reasonInput?.code),
        detail: text(reasonInput?.detail)
      };
      let version = Number(row.version);
      const actor = identity.id;
      const move = (to: string) => {
        this.db
          .prepare("UPDATE contracts SET status = ? WHERE id = ?")
          .run(to, id);
        this.event(id, version, actor, "contract_transition", {
          from: row.status,
          to,
          reason
        });
      };
      if (action === "confirm") {
        if (row.status !== "pending_confirmation")
          throw new RequirementError("INVALID_TRANSITION", 409);
        const result = this.db
          .prepare(
            "INSERT OR IGNORE INTO contract_confirmations VALUES (?, ?, ?, ?, ?)"
          )
          .run(id, version, party, actor, this.now());
        if (result.changes)
          this.event(id, version, actor, "human_confirmation", {
            party,
            reason
          });
        const count = this.db
          .prepare(
            "SELECT count(*) n FROM contract_confirmations WHERE contract_id = ? AND version = ?"
          )
          .get(id, version)!;
        if (count.n === 2) move("active");
      } else if (action === "change") {
        if (!["active", "paused"].includes(String(row.status)))
          throw new RequirementError("INVALID_TRANSITION", 409);
        const value = terms(input.terms);
        version++;
        this.addVersion(id, version, value);
        this.db
          .prepare(
            "UPDATE contracts SET version = ?, settlement = 'unsettled' WHERE id = ?"
          )
          .run(version, id);
        move("pending_confirmation");
        this.event(id, version, actor, "scope_change", {
          fromVersion: row.version,
          toVersion: version,
          reason
        });
      } else if (action === "transition") {
        const to = text(input.to);
        if (!contractEdges[String(row.status)]?.includes(to))
          throw new RequirementError("INVALID_TRANSITION", 409);
        if (to === "completed") {
          if (party !== "buyer") throw new ForbiddenError();
          if (
            this.db
              .prepare(
                "SELECT 1 FROM milestones WHERE contract_id = ? AND version = ? AND status <> 'accepted'"
              )
              .get(id, version)
          )
            throw new RequirementError("MILESTONES_NOT_ACCEPTED", 409);
        }
        move(to);
      } else if (action === "milestone" || action === "review_draft") {
        if (row.status !== "active")
          throw new RequirementError("INVALID_TRANSITION", 409);
        const milestoneId = text(input.milestoneId);
        const milestone = this.db
          .prepare(
            "SELECT * FROM milestones WHERE id = ? AND contract_id = ? AND version = ?"
          )
          .get(milestoneId, id, version);
        if (!milestone) throw new ForbiddenError();
        if (action === "review_draft") {
          if (milestone.status !== "submitted")
            throw new RequirementError("INVALID_TRANSITION", 409);
          this.event(id, version, actor, "acceptance_report_draft", {
            milestoneId,
            report: text(input.report),
            final: false,
            reason
          });
        } else {
          const to = text(input.to);
          if (!milestoneEdges[String(milestone.status)]?.includes(to))
            throw new RequirementError("INVALID_TRANSITION", 409);
          const review = ["accepted", "changes_requested", "rejected"].includes(
            to
          );
          if (party !== (review ? "buyer" : "seller"))
            throw new ForbiddenError();
          const evidence =
            to === "submitted" ? text(input.evidence) : undefined;
          this.db
            .prepare("UPDATE milestones SET status = ? WHERE id = ?")
            .run(to, milestoneId);
          this.event(id, version, actor, "milestone_transition", {
            milestoneId,
            from: milestone.status,
            to,
            reason,
            evidence,
            final: review,
            humanConfirmed: true
          });
        }
      } else if (action === "settlement") {
        if (party !== "buyer") throw new ForbiddenError();
        if (row.status !== "completed" || row.settlement !== "unsettled")
          throw new RequirementError("INVALID_TRANSITION", 409);
        this.db
          .prepare(
            "UPDATE contracts SET settlement = 'manually_confirmed' WHERE id = ?"
          )
          .run(id);
        this.event(id, version, actor, "manual_settlement", {
          from: row.settlement,
          to: "manually_confirmed",
          reason,
          paymentExecuted: false
        });
      } else throw new RequirementError("UNKNOWN_ACTION");
      this.db
        .prepare("UPDATE contracts SET revision = revision + 1 WHERE id = ?")
        .run(id);
      this.db
        .prepare("INSERT INTO contract_requests VALUES (?, ?, ?, ?)")
        .run(id, actor, key, fingerprint);
      return this.read(token, id);
    });
  }
}
