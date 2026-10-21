import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { SqliteIdentityStore } from "./identity.js";
import { audited } from "./security.js";

// Case access never creates contract, workspace or repository grants.
export class Disputes {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now
  ) {
    return audited(
      this,
      db,
      auth,
      ["create", "grant", "revoke", "submit", "read"],
      (method, args, result) => {
        const object = {
          type: "dispute",
          id:
            method === "create"
              ? (result as { id: string }).id
              : String(args[1])
        };
        if (method !== "grant" && method !== "revoke") return object;
        const grantId = (result as { id: string }).id;
        const grant = db
          .prepare(
            "SELECT admin_id, scope, expires_at FROM dispute_grants WHERE id=?"
          )
          .get(grantId)!;
        return {
          ...object,
          targetSubject: "user:" + grant.admin_id,
          permissionChange: {
            permission: String(grant.scope),
            action: method,
            expiresAt: Number(grant.expires_at)
          }
        };
      }
    );
  }
  private party(token: string, contractId: string) {
    const access = this.auth.authorize(
      token,
      { kind: "contract", resourceId: contractId, action: "write" },
      ["buyer", "seller"]
    );
    const row = this.db
      .prepare("SELECT * FROM contracts WHERE id=? AND status='disputed'")
      .get(contractId);
    if (
      !row ||
      access.identity.kind !== "user" ||
      row[access.role + "_id"] !== access.identity.id
    )
      throw new ForbiddenError();
    return access;
  }
  private caseRow(id: string) {
    const row = this.db
      .prepare("SELECT * FROM dispute_cases WHERE id=?")
      .get(id);
    if (!row) throw new ForbiddenError();
    return row;
  }
  create(token: string, contractId: string, confirmed: unknown) {
    const access = this.party(token, contractId);
    if (confirmed !== true) throw new RequirementError("CONFIRMATION_REQUIRED");
    const previous = this.db
      .prepare("SELECT id FROM dispute_cases WHERE contract_id=?")
      .get(contractId);
    if (previous) return { id: String(previous.id) };
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO dispute_cases VALUES (?,?,?,?)")
      .run(id, contractId, access.identity.id, this.now());
    return { id };
  }
  grant(token: string, id: string, input: Record<string, unknown>) {
    const row = this.caseRow(id);
    const access = this.party(token, String(row.contract_id));
    // Human case-view consent is independent of Agent delegation.
    const store = new SqliteIdentityStore(this.db);
    const adminId = typeof input.adminId === "string" ? input.adminId : "";
    if (
      store.user(adminId)?.platformRole !== "admin" ||
      store.role(adminId, { ...access.resource, kind: "project" }) !== "admin"
    )
      throw new ForbiddenError();
    if (input.confirmed !== true)
      throw new RequirementError("CONFIRMATION_REQUIRED");
    if (
      input.scope !== "audit_and_evidence:read" ||
      typeof input.expiresAt !== "number" ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= this.now()
    )
      throw new RequirementError("INVALID_GRANT");
    const grantId = randomUUID();
    this.db
      .prepare("INSERT INTO dispute_grants VALUES (?,?,?,?,?,?,?,NULL,NULL)")
      .run(
        grantId,
        id,
        adminId,
        access.identity.id,
        input.scope,
        this.now(),
        input.expiresAt
      );
    return {
      id: grantId,
      caseId: id,
      adminId,
      grantedBy: access.identity.id,
      scope: input.scope,
      expiresAt: input.expiresAt
    };
  }
  revoke(token: string, id: string, grantId: string) {
    const row = this.caseRow(id);
    const access = this.party(token, String(row.contract_id));
    const grant = this.db
      .prepare("SELECT id FROM dispute_grants WHERE id=? AND case_id=?")
      .get(grantId, id);
    if (!grant) throw new ForbiddenError();
    this.db
      .prepare(
        "UPDATE dispute_grants SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at IS NULL"
      )
      .run(this.now(), access.identity.id, grantId);
    return { id: grantId, revoked: true };
  }
  submit(token: string, id: string, input: Record<string, unknown>) {
    const row = this.caseRow(id);
    const access = this.party(token, String(row.contract_id));
    if (input.confirmed !== true)
      throw new RequirementError("CONFIRMATION_REQUIRED");
    if (
      typeof input.eventSequence !== "number" ||
      !Number.isSafeInteger(input.eventSequence) ||
      !this.db
        .prepare(
          "SELECT 1 FROM contract_events WHERE sequence=? AND contract_id=?"
        )
        .get(input.eventSequence, String(row.contract_id))
    )
      throw new ForbiddenError();
    const evidenceId = randomUUID();
    this.db
      .prepare("INSERT OR IGNORE INTO dispute_evidence VALUES (?,?,?,?,?,?)")
      .run(
        evidenceId,
        id,
        access.identity.id,
        access.role,
        input.eventSequence,
        this.now()
      );
    return this.db
      .prepare(
        "SELECT id, party, event_sequence FROM dispute_evidence WHERE case_id=? AND submitted_by=? AND event_sequence=?"
      )
      .get(id, access.identity.id, input.eventSequence);
  }
  read(token: string, id: string) {
    const access = this.auth.authorize(
      token,
      { kind: "dispute", resourceId: id, action: "read" },
      ["admin"]
    );
    if (access.identity.kind !== "user") throw new ForbiddenError();
    const row = this.caseRow(id);
    // Explicit allowlist: no raw event payloads, identity details, scopes or private terms.
    return {
      id,
      contractId: String(row.contract_id),
      status: "disputed",
      audit: this.db
        .prepare(
          "SELECT sequence, event, result, created_at FROM audit_events WHERE tenant_id=? AND ((object_type='contract' AND object_id=?) OR (object_type='dispute' AND object_id=?)) ORDER BY sequence"
        )
        .all(access.resource.organizationId, String(row.contract_id), id),
      evidence: this.db
        .prepare(
          "SELECT id, party, event_sequence, created_at FROM dispute_evidence WHERE case_id=? ORDER BY created_at, id"
        )
        .all(id)
    };
  }
}
