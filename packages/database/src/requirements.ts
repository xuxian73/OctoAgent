import { Scanner, FakeScanner, scanFile } from "../../security/src/index.js";
import { audited } from "./security.js";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Authorization,
  ForbiddenError,
  tokenDigest
} from "../../auth/src/index.js";
import {
  Draft,
  Field,
  parseDraft,
  RequirementError,
  summary,
  validate
} from "../../requirements/src/model.js";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const types: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "image/png": ".png",
  "image/jpeg": ".jpg"
};
export class Requirements {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private now = Date.now,
    private scanner: Scanner = new FakeScanner()
  ) {
    return audited(
      this,
      db,
      auth,
      [
        "inspect",
        "create",
        "read",
        "save",
        "preview",
        "publish",
        "publicView",
        "addAttachment",
        "attachment"
      ],
      (method, args, result) => ({
        type: ["addAttachment", "attachment"].includes(method)
          ? "attachment"
          : "requirement",
        id: ["create", "addAttachment", "attachment", "publicView"].includes(
          method
        )
          ? (result as { id: string }).id
          : (args[1] as string)
      })
    );
  }
  private access(token: string, project: string, write = false) {
    // Mutations return the saved private draft, so require read access before writing.
    if (write) this.access(token, project);
    return this.auth.authorize(
      token,
      {
        kind: "project",
        resourceId: project,
        action: write ? "write" : "read"
      },
      ["buyer"]
    );
  }
  private row(token: string, id: string, write = false) {
    const row = this.db
      .prepare("SELECT * FROM requirements WHERE id = ?")
      .get(id);
    if (!row) throw new ForbiddenError();
    const access = this.access(token, String(row.project_id), write);
    return { row, access };
  }
  inspect(token: string, id: string, write = false) {
    this.row(token, id, write);
    return this.read(token, id);
  }
  create(token: string, project: string, input: unknown) {
    this.access(token, project, true);
    const draft = parseDraft(input);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO requirements (id, project_id, revision, version, draft) VALUES (?, ?, 1, 0, ?)"
      )
      .run(id, project, JSON.stringify(draft));
    return this.read(token, id);
  }
  read(token: string, id: string) {
    const { row } = this.row(token, id);
    const draft = JSON.parse(String(row.draft)) as Draft;
    return {
      id,
      projectId: row.project_id,
      revision: Number(row.revision),
      version: Number(row.version),
      draft,
      validation: validate(draft),
      attachments: this.db
        .prepare(
          "SELECT id, name, mime, size, private, 0 AS hasBytes, 'legacy_metadata_only' AS scan_status FROM requirement_attachments WHERE requirement_id = ?"
        )
        .all(id),
      changes: this.db
        .prepare(
          "SELECT version, changed_fields FROM requirement_changes WHERE requirement_id = ? ORDER BY version"
        )
        .all(id)
    };
  }
  save(token: string, id: string, revision: number, input: unknown) {
    this.row(token, id, true);
    const draft = parseDraft(input);
    const result = this.db
      .prepare(
        "UPDATE requirements SET draft = ?, revision = revision + 1 WHERE id = ? AND revision = ?"
      )
      .run(JSON.stringify(draft), id, revision);
    if (!result.changes) throw new RequirementError("REVISION_CONFLICT", 409);
    return this.read(token, id);
  }
  preview(token: string, id: string) {
    const { row, access } = this.row(token, id, true);
    if (access.identity.kind !== "user") throw new ForbiddenError();
    const draft = JSON.parse(String(row.draft)) as Draft;
    const validation = validate(draft);
    if (validation.missing.length || validation.invalid.length)
      throw new RequirementError("INCOMPLETE_DRAFT", 422);
    const confirmation = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO requirement_confirmations VALUES (?, ?, ?, ?, ?)")
      .run(
        tokenDigest(confirmation),
        id,
        row.revision!,
        access.identity.id,
        this.now() + 600000
      );
    return {
      summary: {
        ...summary(draft),
        attachments: this.read(token, id).attachments
      },
      validation,
      confirmation,
      revision: row.revision,
      publicFields: draft.publicFields,
      requires_human_confirmation: true
    };
  }
  publish(token: string, id: string, confirmation: string, confirmed: boolean) {
    const { access } = this.row(token, id, true);
    if (access.identity.kind !== "user") throw new ForbiddenError();
    if (confirmed !== true || typeof confirmation !== "string")
      throw new RequirementError("CONFIRMATION_REQUIRED");
    this.db.exec("SAVEPOINT service_operation");
    try {
      const { row } = this.row(token, id, true);
      const proof = this.db
        .prepare(
          "SELECT * FROM requirement_confirmations WHERE digest = ? AND requirement_id = ? AND actor_id = ?"
        )
        .get(tokenDigest(confirmation), id, access.identity.id);
      if (
        !proof ||
        proof.revision !== row.revision ||
        Number(proof.expires_at) <= this.now()
      )
        throw new RequirementError("STALE_CONFIRMATION", 409);
      const draft = JSON.parse(String(row.draft)) as Draft;
      const check = validate(draft);
      if (check.missing.length || check.invalid.length)
        throw new RequirementError("INCOMPLETE_DRAFT", 422);
      const previous = row.published
        ? (JSON.parse(String(row.published)) as Draft)
        : null;
      const changed = Array.from(
        new Set([
          ...Object.keys(previous?.values || {}),
          ...Object.keys(draft.values)
        ])
      ).filter(
        key => previous?.values[key as Field] !== draft.values[key as Field]
      );
      if (JSON.stringify(previous?.market) !== JSON.stringify(draft.market))
        changed.push("market");
      if (
        JSON.stringify(previous?.publicFields) !==
        JSON.stringify(draft.publicFields)
      )
        changed.push("publicFields");
      const attachments = this.db
        .prepare(
          "SELECT id, name, mime, size FROM requirement_attachments WHERE requirement_id = ? AND private = 0"
        )
        .all(id);
      if (JSON.stringify(attachments) !== row.published_attachments)
        changed.push("attachments");
      const version = Number(row.version) + 1;
      this.db
        .prepare(
          "UPDATE requirements SET published = draft, published_attachments = ?, version = ?, revision = revision + 1 WHERE id = ?"
        )
        .run(JSON.stringify(attachments), version, id);
      this.db
        .prepare("INSERT INTO requirement_changes VALUES (?, ?, ?, ?)")
        .run(id, version, access.identity.id, JSON.stringify(changed));
      if (version > 1)
        this.db
          .prepare(
            "INSERT INTO requirement_notifications SELECT requirement_id, ?, user_id, 'requirement_changed' FROM requirement_participants WHERE requirement_id = ?"
          )
          .run(version, id);
      this.db
        .prepare(
          "DELETE FROM requirement_confirmations WHERE requirement_id = ?"
        )
        .run(id);
      this.db.exec("RELEASE service_operation");
    } catch (error) {
      this.db.exec("ROLLBACK TO service_operation; RELEASE service_operation");
      throw error;
    }
    return this.read(token, id);
  }
  publicView(id: string) {
    const row = this.db
      .prepare(
        "SELECT version, published, published_attachments FROM requirements WHERE id = ? AND version > 0"
      )
      .get(id);
    if (!row) throw new RequirementError("NOT_FOUND", 404);
    const draft = JSON.parse(String(row.published)) as Draft;
    const marketPublication = this.db
      .prepare(
        "SELECT 1 FROM requirement_changes c, json_each(c.changed_fields) f WHERE c.requirement_id=? AND f.value='market'"
      )
      .get(id);
    if (
      marketPublication &&
      (!draft.market || draft.market.deadline <= this.now())
    )
      throw new RequirementError("NOT_FOUND", 404);
    return {
      id,
      version: row.version,
      values: Object.fromEntries(
        draft.publicFields.map(key => [key, draft.values[key]])
      ),
      attachments: draft.market
        ? []
        : JSON.parse(String(row.published_attachments))
    };
  }
  addAttachment(token: string, id: string, input: unknown) {
    this.row(token, id, true);
    const value = input as {
      revision: number;
      name: string;
      mime: string;
      size: number;
      private?: boolean;
    };
    if (
      !value ||
      typeof value.name !== "string" ||
      value.name.length > 200 ||
      /[\/\\\x00-\x1f]/.test(value.name) ||
      typeof value.mime !== "string" ||
      !Object.hasOwn(types, value.mime) ||
      !value.name.toLowerCase().endsWith(types[value.mime]!) ||
      !Number.isSafeInteger(value.size) ||
      value.size <= 0 ||
      value.size > MAX_ATTACHMENT_BYTES ||
      (value.private !== undefined && typeof value.private !== "boolean")
    )
      throw new RequirementError("INVALID_ATTACHMENT");
    if (!Number.isSafeInteger(value.revision))
      throw new RequirementError("REVISION_REQUIRED");
    scanFile(value, this.scanner);
    const attachmentId = randomUUID();
    this.db.exec("SAVEPOINT service_operation");
    try {
      const result = this.db
        .prepare(
          "UPDATE requirements SET revision = revision + 1 WHERE id = ? AND revision = ?"
        )
        .run(id, value.revision);
      if (!result.changes) throw new RequirementError("REVISION_CONFLICT", 409);
      this.db
        .prepare(
          "INSERT INTO requirement_attachments VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          attachmentId,
          id,
          value.name,
          value.mime,
          value.size,
          value.private === false ? 0 : 1
        );
      const attachments = this.read(token, id).attachments;
      this.db.exec("RELEASE service_operation");
      return { id: attachmentId, revision: value.revision + 1, attachments };
    } catch (error) {
      this.db.exec("ROLLBACK TO service_operation; RELEASE service_operation");
      throw error;
    }
  }
  attachment(token: string, id: string, attachmentId: string) {
    this.row(token, id);
    const value = this.db
      .prepare(
        "SELECT id, name, mime, size, private, 0 AS hasBytes, 'legacy_metadata_only' AS scan_status FROM requirement_attachments WHERE id = ? AND requirement_id = ?"
      )
      .get(attachmentId, id);
    if (!value) throw new ForbiddenError();
    return value;
  }
}
