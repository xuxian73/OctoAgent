import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Authorization,
  ForbiddenError,
  tokenDigest
} from "../../auth/src/index.js";
import { Draft, RequirementError } from "../../requirements/src/model.js";
import { parseProposal, Proposal } from "../../requirements/src/bids.js";
export class Market {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now
  ) {}
  private transaction<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT market_operation" : "BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec(nested ? "RELEASE market_operation" : "COMMIT");
      return result;
    } catch (e) {
      this.db.exec(
        nested
          ? "ROLLBACK TO market_operation; RELEASE market_operation"
          : "ROLLBACK"
      );
      throw e;
    }
  }
  private task(
    token: string,
    id: string,
    write = false,
    role?: "buyer" | "seller"
  ) {
    const row = this.db
      .prepare("SELECT * FROM requirements WHERE id = ? AND version > 0")
      .get(id);
    if (!row) throw new ForbiddenError();
    const scope = {
      kind: "project" as const,
      resourceId: String(row.project_id),
      action: "read" as const
    };
    const access = this.auth.authorize(
      token,
      scope,
      role ? [role] : ["buyer", "seller"]
    );
    if (write)
      this.auth.authorize(
        token,
        { ...scope, action: "write" },
        role ? [role] : ["buyer", "seller"]
      );
    const draft = JSON.parse(String(row.published)) as Draft;
    if (
      !draft.market ||
      (access.identity.kind === "agent" && !draft.market.allowAgents)
    )
      throw new ForbiddenError();
    return { row, draft, access };
  }
  private open(deadline: number) {
    if (deadline <= this.now())
      throw new RequirementError("BIDDING_CLOSED", 409);
  }
  inspectTask(
    token: string,
    id: string,
    write = false,
    role?: "buyer" | "seller"
  ) {
    const context = this.task(token, id, write, role);
    return {
      projectId: String(context.row.project_id),
      role: context.access.role,
      detail: this.detail(token, id)
    };
  }
  inspectBid(token: string, id: string, role: "buyer" | "seller") {
    const context = this.bidAccess(token, id, true);
    if (context.access.role !== role) throw new ForbiddenError();
    return this.bid(token, id);
  }
  clarify(token: string, id: string, topic: string, text: string) {
    const { access } = this.task(token, id, true, "seller");
    return this.event(
      id,
      access.identity.id,
      access.identity.responsibleUserId,
      "clarification",
      {
        topic: this.text(topic),
        text: this.text(text)
      }
    );
  }
  search(token: string, project: string, filters: Record<string, string> = {}) {
    this.auth.authorize(
      token,
      { kind: "project", resourceId: project, action: "read" },
      ["buyer", "seller"]
    );
    if (
      (filters.allowAgents &&
        !["true", "false"].includes(filters.allowAgents)) ||
      (filters.risk && !["low", "medium", "high"].includes(filters.risk)) ||
      ["maxDays", "deadlineAfter"].some(
        key =>
          filters[key] &&
          (!Number.isFinite(Number(filters[key])) || Number(filters[key]) <= 0)
      )
    )
      throw new RequirementError("INVALID_FILTER");
    const results = [];
    for (const row of this.db
      .prepare(
        "SELECT id FROM requirements WHERE project_id = ? AND version > 0 ORDER BY id"
      )
      .all(project)) {
      try {
        const detail = this.detail(token, String(row.id));
        const m = detail.market!;
        // Only published, authorized fields participate in filtering.
        if (
          filters.capabilities &&
          !filters.capabilities
            .split(",")
            .every(tag =>
              (m.capabilities || []).some(
                v => v.toLowerCase() === tag.trim().toLowerCase()
              )
            )
        )
          continue;
        if (
          filters.permissions &&
          !String(detail.values.permissions || "")
            .toLowerCase()
            .includes(filters.permissions.toLowerCase())
        )
          continue;
        if (m.deadline <= this.now()) continue;
        if (
          filters.stack &&
          !String(detail.values.stack)
            .toLowerCase()
            .split(/[\s,，]+/)
            .includes(filters.stack.toLowerCase())
        )
          continue;
        if (
          ["taskType", "budgetType"].some(
            k => filters[k] && detail.values[k] !== filters[k]
          )
        )
          continue;
        if (filters.risk && filters.risk !== m.risk) continue;
        if (
          filters.allowAgents &&
          String(m.allowAgents) !== filters.allowAgents
        )
          continue;
        if (filters.maxDays && m.durationDays > Number(filters.maxDays))
          continue;
        if (filters.deadlineAfter && m.deadline < Number(filters.deadlineAfter))
          continue;
        results.push(detail);
      } catch (e) {
        if (!(e instanceof ForbiddenError)) throw e;
      }
    }
    return results;
  }
  detail(token: string, id: string) {
    const { row, draft } = this.task(token, id);
    return {
      id,
      version: Number(row.version),
      market: draft.market,
      values: Object.fromEntries(
        draft.publicFields.map(k => [k, draft.values[k]])
      ),
      attachments: JSON.parse(String(row.published_attachments)),
      timeline: this.timeline(token, id)
    };
  }
  private event(
    id: string,
    actor: string,
    audience: string,
    kind: string,
    payload: unknown
  ) {
    const result = this.db
      .prepare(
        "INSERT INTO market_events (requirement_id, actor_id, audience, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, actor, audience, kind, JSON.stringify(payload), this.now());
    return Number(result.lastInsertRowid);
  }
  draft(token: string, taskId: string, input: unknown) {
    const { row, draft, access } = this.task(token, taskId, true, "seller");
    this.open(draft.market!.deadline);
    const proposal = parseProposal(input);
    return this.transaction(() => {
      const version =
        Number(
          this.db
            .prepare(
              "SELECT coalesce(max(version), 0) AS v FROM bids WHERE requirement_id = ? AND owner_id = ?"
            )
            .get(taskId, access.identity.responsibleUserId)!.v
        ) + 1;
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO bids VALUES (?, ?, ?, ?, ?, ?, 'draft')")
        .run(
          id,
          taskId,
          access.identity.responsibleUserId,
          version,
          row.version!,
          JSON.stringify(proposal)
        );
      this.event(
        taskId,
        access.identity.id,
        access.identity.responsibleUserId,
        "bid_drafted",
        { id, version }
      );
      return this.bid(token, id);
    });
  }
  private bidAccess(token: string, id: string, write = false) {
    const bid = this.db.prepare("SELECT * FROM bids WHERE id = ?").get(id);
    if (!bid) throw new ForbiddenError();
    const context = this.task(token, String(bid.requirement_id), write);
    if (
      context.access.role === "seller" &&
      bid.owner_id !== context.access.identity.responsibleUserId
    )
      throw new ForbiddenError();
    if (context.access.role === "buyer" && bid.status === "draft")
      throw new ForbiddenError();
    return { bid, ...context };
  }
  bid(token: string, id: string) {
    const { bid, row } = this.bidAccess(token, id);
    return {
      id: String(bid.id),
      owner_id: String(bid.owner_id),
      status: String(bid.status),
      version: Number(bid.version),
      task_version: Number(bid.task_version),
      stale: bid.task_version !== row.version,
      requirement_id: String(bid.requirement_id),
      proposal: JSON.parse(String(bid.proposal)) as Proposal
    };
  }
  preview(token: string, id: string) {
    const { bid, draft, access, row } = this.bidAccess(token, id, true);
    if (access.identity.kind !== "user" || access.identity.id !== bid.owner_id)
      throw new ForbiddenError();
    this.open(draft.market!.deadline);
    if (bid.status !== "draft" || bid.task_version !== row.version)
      throw new RequirementError("STALE_BID", 409);
    const confirmation = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO bid_confirmations VALUES (?, ?, ?, ?)")
      .run(
        tokenDigest(confirmation),
        id,
        access.identity.id,
        this.now() + 600000
      );
    return {
      bid: this.bid(token, id),
      confirmation,
      expires_at: this.now() + 600000,
      requires_human_confirmation: true
    };
  }
  submit(token: string, id: string, confirmation: string, confirmed: boolean) {
    return this.transaction(() => {
      const { bid, draft, access, row } = this.bidAccess(token, id, true);
      if (
        access.identity.kind !== "user" ||
        access.identity.id !== bid.owner_id
      )
        throw new ForbiddenError();
      if (confirmed !== true || typeof confirmation !== "string")
        throw new RequirementError("CONFIRMATION_REQUIRED");
      const proof = this.db
        .prepare(
          "SELECT * FROM bid_confirmations WHERE digest = ? AND bid_id = ? AND actor_id = ?"
        )
        .get(tokenDigest(confirmation), id, access.identity.id);
      if (!proof) throw new RequirementError("STALE_CONFIRMATION", 409);
      // A retry of the same confirmed submission is read-only, even after the deadline.
      if (bid.status === "submitted") return this.bid(token, id);
      this.open(draft.market!.deadline);
      if (
        bid.status !== "draft" ||
        Number(proof.expires_at) <= this.now() ||
        bid.task_version !== row.version
      )
        throw new RequirementError("STALE_CONFIRMATION", 409);
      const later = this.db
        .prepare(
          "SELECT id FROM bids WHERE requirement_id = ? AND owner_id = ? AND version > ? AND status <> 'draft'"
        )
        .get(bid.requirement_id!, bid.owner_id!, bid.version!);
      if (later) throw new RequirementError("STALE_BID", 409);
      this.db
        .prepare("UPDATE bids SET status = 'submitted' WHERE id = ?")
        .run(id);
      this.db
        .prepare("INSERT OR IGNORE INTO requirement_participants VALUES (?, ?)")
        .run(bid.requirement_id!, bid.owner_id!);
      this.event(
        String(bid.requirement_id),
        access.identity.id,
        String(bid.owner_id),
        "bid_submitted",
        { id, version: bid.version }
      );
      return this.bid(token, id);
    });
  }
  withdraw(token: string, id: string) {
    return this.transaction(() => {
      const { bid, access } = this.bidAccess(token, id, true);
      if (access.identity.responsibleUserId !== bid.owner_id)
        throw new ForbiddenError();
      if (bid.status === "draft")
        throw new RequirementError("BID_NOT_SUBMITTED", 409);
      if (bid.status !== "withdrawn") {
        this.db
          .prepare("UPDATE bids SET status = 'withdrawn' WHERE id = ?")
          .run(id);
        this.event(
          String(bid.requirement_id),
          access.identity.id,
          String(bid.owner_id),
          "bid_withdrawn",
          { id, version: bid.version }
        );
      }
      return this.bid(token, id);
    });
  }
  supplement(token: string, id: string, text: unknown) {
    const { bid, access } = this.bidAccess(token, id, true);
    if (
      access.identity.responsibleUserId !== bid.owner_id ||
      bid.status !== "submitted"
    )
      throw new ForbiddenError();
    return this.event(
      String(bid.requirement_id),
      access.identity.id,
      String(bid.owner_id),
      "supplement",
      { id, text: this.text(text) }
    );
  }
  private text(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 10000)
      throw new RequirementError("INVALID_TEXT");
    return value.trim();
  }
  listBids(token: string, id: string) {
    const { access } = this.task(token, id);
    return this.db
      .prepare(
        "SELECT id, owner_id, status FROM bids WHERE requirement_id = ? ORDER BY owner_id, version"
      )
      .all(id)
      .filter(b =>
        access.role === "buyer"
          ? b.status !== "draft"
          : b.owner_id === access.identity.responsibleUserId
      )
      .map(b => this.bid(token, String(b.id)));
  }
  compare(token: string, id: string, sort = "risk") {
    this.task(token, id, false, "buyer");
    if (!["risk", "days", "capabilities", "price"].includes(sort))
      throw new RequirementError("INVALID_SORT");
    const latest = new Map<string, ReturnType<Market["bid"]>>();
    for (const bid of this.listBids(token, id))
      latest.set(String(bid.owner_id), bid);
    const risk = { low: 0, medium: 1, high: 2 };
    return [...latest.values()]
      .filter(b => b.status === "submitted" && !b.stale)
      .sort((a, b) => {
        const score = (p: Proposal) =>
          sort === "risk"
            ? risk[p.risk]
            : sort === "capabilities"
            ? -p.capabilities.length
            : p[sort as "days" | "price"];
        return (
          score(a.proposal) - score(b.proposal) ||
          risk[a.proposal.risk] - risk[b.proposal.risk] ||
          a.proposal.days - b.proposal.days ||
          String(a.id).localeCompare(String(b.id))
        );
      });
  }
  question(
    token: string,
    id: string,
    recipient: unknown,
    topic: unknown,
    text: unknown
  ) {
    const { access } = this.task(token, id, true, "buyer");
    if (
      typeof recipient !== "string" ||
      (recipient !== "all" && !this.participant(id, recipient))
    )
      throw new ForbiddenError();
    return this.event(id, access.identity.id, recipient, "question", {
      topic: this.text(topic),
      text: this.text(text)
    });
  }
  private participant(id: string, user: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM requirement_participants WHERE requirement_id = ? AND user_id = ?"
      )
      .get(id, user);
  }
  answer(
    token: string,
    id: string,
    questionId: unknown,
    answer: unknown,
    evidence: unknown,
    impact: unknown
  ) {
    const { access } = this.task(token, id, true, "seller");
    const question = this.timeline(token, id).find(
      e => e.sequence === questionId && e.kind === "question"
    );
    if (!question || !this.participant(id, access.identity.responsibleUserId))
      throw new ForbiddenError();
    return this.event(
      id,
      access.identity.id,
      access.identity.responsibleUserId,
      "answer",
      {
        questionId,
        answer: this.text(answer),
        evidence: this.text(evidence),
        impact: this.text(impact)
      }
    );
  }
  timeline(token: string, id: string) {
    const { access } = this.task(token, id);
    return this.db
      .prepare(
        "SELECT * FROM market_events WHERE requirement_id = ? ORDER BY created_at, sequence"
      )
      .all(id)
      .filter(
        e =>
          (access.role === "buyer" && e.kind !== "bid_drafted") ||
          (access.role === "seller" &&
            (e.audience === access.identity.responsibleUserId ||
              (e.audience === "all" &&
                this.participant(id, access.identity.responsibleUserId))))
      )
      .map(e => ({
        sequence: Number(e.sequence),
        kind: String(e.kind),
        actor_id: String(e.actor_id),
        created_at: Number(e.created_at),
        payload: JSON.parse(String(e.payload))
      }));
  }
}
