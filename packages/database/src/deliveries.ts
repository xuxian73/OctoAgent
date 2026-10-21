import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { Files } from "./files.js";
import { validateZip } from "../../security/src/zip.js";

function text(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 10000)
    throw new RequirementError("EVIDENCE_INCOMPLETE", 409);
  return value.trim();
}
/** Invoked only inside the enclosing contract/workspace transaction. */
export class Deliveries {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now
  ) {}
  list(id: string) {
    return this.db
      .prepare(
        "SELECT * FROM zip_deliveries WHERE contract_id=? ORDER BY rowid"
      )
      .all(id);
  }
  current(milestoneId: string) {
    return this.db
      .prepare(
        "SELECT * FROM zip_deliveries WHERE milestone_id=? ORDER BY delivery_version DESC LIMIT 1"
      )
      .get(milestoneId);
  }
  submit(
    token: string,
    id: string,
    version: number,
    input: Record<string, unknown>
  ) {
    const access = this.auth.authorize(
      token,
      { kind: "contract", resourceId: id, action: "write" },
      ["seller"]
    );
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM delivery_permissions WHERE contract_id=? AND actor_id=? AND permission='submit' AND expires_at>?"
        )
        .get(id, access.identity.id, this.now())
    )
      throw new ForbiddenError();
    const contract = this.db
      .prepare("SELECT * FROM contracts WHERE id=?")
      .get(id)!;
    if (contract.status !== "active" || contract.version !== version)
      throw new RequirementError("CONTRACT_NOT_ACTIVE", 409);
    const milestoneId = text(input.milestoneId);
    const milestone = this.db
      .prepare(
        "SELECT * FROM milestones WHERE id=? AND contract_id=? AND version=?"
      )
      .get(milestoneId, id, version);
    if (
      !milestone ||
      !["planned", "in_progress", "changes_requested"].includes(
        String(milestone.status)
      )
    )
      throw new RequirementError("INVALID_MILESTONE", 409);
    const fileId = text(input.fileId);
    const { metadata: file, bytes } = new Files(this.db, this.auth).download(
      token,
      fileId
    );
    if (
      file.kind !== "artifact" ||
      file.resource_id !== id ||
      file.version !== version ||
      file.milestone_id !== milestoneId ||
      file.responsible_user !== access.identity.responsibleUserId ||
      file.responsible_user !== contract.seller_id ||
      file.mime !== "application/zip"
    )
      throw new RequirementError("ARTIFACT_BINDING_MISMATCH", 409);
    validateZip(bytes);
    if (
      this.db
        .prepare("SELECT 1 FROM zip_deliveries WHERE file_id=?")
        .get(fileId)
    )
      throw new RequirementError("FILE_ALREADY_SUBMITTED", 409);
    const result = {
      id: randomUUID(),
      contract_id: id,
      version,
      milestone_id: milestoneId,
      delivery_version:
        Number(this.current(milestoneId)?.delivery_version || 0) + 1,
      file_id: fileId,
      responsible_user: String(file.responsible_user),
      summary: text(input.summary),
      instructions: text(input.instructions),
      known_issues: text(input.knownIssues),
      checksum: String(file.checksum),
      created_at: this.now()
    };
    this.db
      .prepare("INSERT INTO zip_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(...Object.values(result));
    return result;
  }
  verify(token: string, milestoneId: string) {
    const current = this.current(milestoneId);
    if (!current) throw new RequirementError("EVIDENCE_INCOMPLETE", 409);
    const { metadata } = new Files(this.db, this.auth).download(
      token,
      String(current.file_id)
    );
    if (metadata.checksum !== current.checksum)
      throw new RequirementError("FILE_INTEGRITY_FAILED", 409);
    return current;
  }
}
