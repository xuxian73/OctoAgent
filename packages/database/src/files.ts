import { securityContext, requestContext } from "../../security/src/index.js";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { Requirements } from "./requirements.js";
import { Workspaces } from "./workspaces.js";
import { Audit } from "./security.js";

export type ScanStatus =
  | "quarantined"
  | "clean"
  | "infected"
  | "failed"
  | "unverifiable";
/** Trusted server adapter only; never accept scanner identity/status from HTTP. */
export interface ByteScanner {
  readonly name: string;
  readonly simulated: boolean;
  scan(bytes: Uint8Array, checksum: string): Exclude<ScanStatus, "quarantined">;
}
export interface FileBinding {
  kind: "requirement" | "artifact";
  resourceId: string;
  version: number;
  revision: number;
  milestoneId: string;
  sha: string;
}
export interface FileUpload extends FileBinding {
  name: string;
  mime: string;
  requestKey: string;
  checksum?: string;
}
export const fileTypes: Record<string, string> = {
  ".ts": "text/plain",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".zip": "application/zip"
};
export interface FileLimits {
  maxBytes: number;
  maxCount: number;
  extensions: string[];
}
const defaults: FileLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxCount: 20,
  extensions: Object.keys(fileTypes)
};
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256")
    .update(bytes)
    .digest("hex");
const columns =
  "id, kind, resource_id, version, revision, milestone_id, sha, actor, responsible_user, name, mime, size, checksum, scan_status, scanner, simulated";
export class Files {
  readonly limits: FileLimits;
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private scanner?: ByteScanner,
    limits: Partial<FileLimits> = {}
  ) {
    this.limits = { ...defaults, ...limits };
    if (
      !Number.isSafeInteger(this.limits.maxBytes) ||
      this.limits.maxBytes < 1 ||
      this.limits.maxBytes > defaults.maxBytes ||
      !Number.isSafeInteger(this.limits.maxCount) ||
      this.limits.maxCount < 1 ||
      this.limits.extensions.some(e => !Object.hasOwn(fileTypes, e))
    )
      throw new Error("INVALID_FILE_LIMITS");
  }
  private access(token: string, b: FileBinding, write = false) {
    if (b.kind === "requirement") {
      const value = new Requirements(this.db, this.auth).inspect(
        token,
        b.resourceId,
        write
      );
      if (
        write &&
        (value.version !== b.version ||
          value.revision !== b.revision ||
          b.milestoneId !== "" ||
          b.sha !== "")
      )
        throw new RequirementError("STALE_REQUIREMENT", 409);
    } else if (b.kind === "artifact") {
      const service = new Workspaces(this.db, this.auth);
      const value = write
        ? service.inspect(token, b.resourceId, "artifact")
        : service.read(token, b.resourceId);
      if (
        write &&
        (value.version !== b.version ||
          !value.commits.some(
            c => c.sha === b.sha && c.version === b.version
          ) ||
          !this.db
            .prepare(
              "SELECT id FROM milestones WHERE id = ? AND contract_id = ? AND version = ?"
            )
            .get(b.milestoneId, b.resourceId, b.version))
      )
        throw new RequirementError("STALE_ARTIFACT", 409);
    } else throw new ForbiddenError();
    return this.auth.identity(token);
  }
  private binding(row: Record<string, unknown>): FileBinding {
    return {
      kind: row.kind as FileBinding["kind"],
      resourceId: String(row.resource_id),
      version: Number(row.version),
      revision: Number(row.revision),
      milestoneId: String(row.milestone_id),
      sha: String(row.sha)
    };
  }
  list(token: string, kind: FileBinding["kind"], resourceId: string) {
    this.access(token, {
      kind,
      resourceId,
      version: 0,
      revision: 0,
      milestoneId: "",
      sha: ""
    });
    return this.db
      .prepare(
        `SELECT ${columns} FROM private_files WHERE kind = ? AND resource_id = ?`
      )
      .all(kind, resourceId);
  }
  upload(token: string, input: FileUpload, bytes: Uint8Array) {
    if (
      !input ||
      !Number.isSafeInteger(input.version) ||
      input.version < 0 ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      [input.resourceId, input.milestoneId, input.sha].some(
        value => typeof value !== "string" || value.length > 200
      )
    )
      throw new RequirementError("INVALID_FILE_BINDING");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      bytes.length > this.limits.maxBytes
    )
      throw new RequirementError("FILE_SIZE_LIMIT", 413);
    if (
      typeof input.name !== "string" ||
      !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,179}$/u.test(input.name) ||
      input.name.includes("..") ||
      typeof input.requestKey !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey)
    )
      throw new RequirementError("INVALID_FILE");
    const ext = input.name.slice(input.name.lastIndexOf(".")).toLowerCase();
    if (!this.limits.extensions.includes(ext) || fileTypes[ext] !== input.mime)
      throw new RequirementError("FILE_TYPE_REJECTED", 415);
    try {
      if (ext === ".zip") {
        if (
          Buffer.from(bytes)
            .subarray(0, 4)
            .toString("hex") !== "504b0304"
        )
          throw new Error();
      } else {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error();
        if (ext === ".json") JSON.parse(text);
      }
    } catch {
      throw new RequirementError("FILE_TYPE_REJECTED", 415);
    }
    const checksum = digest(bytes);
    if (input.checksum !== undefined && input.checksum !== checksum)
      throw new RequirementError("CHECKSUM_MISMATCH");
    // Explicit canonical fields: client-supplied size/status/storage IDs have no effect.
    const fingerprint = digest(
      JSON.stringify([
        input.kind,
        input.resourceId,
        input.version,
        input.revision,
        input.milestoneId,
        input.sha,
        input.name,
        input.mime,
        checksum
      ])
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const identity = this.access(token, input, true);
      const actor = identity.kind + ":" + identity.id;
      const prior = this.db
        .prepare(
          "SELECT id, fingerprint FROM private_files WHERE actor = ? AND request_key = ?"
        )
        .get(actor, input.requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new RequirementError("REQUEST_KEY_REUSED", 409);
        const result = this.metadata(token, String(prior.id));
        this.db.exec("COMMIT");
        return result;
      }
      const count = this.db
        .prepare(
          "SELECT count(*) AS n FROM private_files WHERE kind = ? AND resource_id = ? AND version = ?"
        )
        .get(input.kind, input.resourceId, input.version)!;
      if (Number(count.n) >= this.limits.maxCount)
        throw new RequirementError("FILE_COUNT_LIMIT", 413);
      const id = randomUUID();
      const responsible =
        identity.kind === "user"
          ? identity.id
          : String(
              this.db
                .prepare("SELECT responsible_user_id FROM agents WHERE id = ?")
                .get(identity.id)?.responsible_user_id
            );
      this.db
        .prepare(
          "INSERT INTO private_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          id,
          input.kind,
          input.resourceId,
          input.version,
          input.revision,
          input.milestoneId,
          input.sha,
          actor,
          responsible,
          input.requestKey,
          fingerprint,
          input.name,
          input.mime,
          bytes.length,
          checksum,
          "quarantined",
          "none",
          0,
          bytes
        );
      securityContext.run(
        { ...(securityContext.getStore() || requestContext()), actor },
        () =>
          new Audit(this.db).append("Files.upload", "success", {
            type: input.kind === "artifact" ? "contract" : "requirement",
            id: input.resourceId
          })
      );
      const result = this.metadata(token, id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  metadata(token: string, id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM private_files WHERE id = ?`)
      .get(id);
    if (!row) throw new ForbiddenError();
    this.access(token, this.binding(row));
    return row;
  }
  /** Background scanner entry point, intentionally absent from HTTP API. */
  scan(id: string) {
    const row = this.db
      .prepare("SELECT bytes, checksum FROM private_files WHERE id = ?")
      .get(id);
    if (!row) throw new ForbiddenError();
    let status: ScanStatus = "unverifiable";
    if (this.scanner) {
      try {
        status = this.scanner.scan(
          new Uint8Array(row.bytes as Uint8Array),
          String(row.checksum)
        );
      } catch {
        status = "failed";
      }
      if (!["clean", "infected", "failed", "unverifiable"].includes(status))
        status = "failed";
    }
    this.db
      .prepare(
        "UPDATE private_files SET scan_status = ?, scanner = ?, simulated = ? WHERE id = ?"
      )
      .run(
        status,
        this.scanner?.name || "none",
        this.scanner?.simulated ? 1 : 0,
        id
      );
  }
  download(token: string, id: string) {
    const metadata = this.metadata(token, id);
    if (metadata.scan_status !== "clean")
      throw new RequirementError("FILE_SCAN_BLOCKED", 409);
    const bytes = Buffer.from(
      this.db.prepare("SELECT bytes FROM private_files WHERE id = ?").get(id)!
        .bytes as Uint8Array
    );
    if (bytes.length !== metadata.size || digest(bytes) !== metadata.checksum)
      throw new RequirementError("FILE_INTEGRITY_FAILED", 409);
    return { metadata, bytes };
  }
}
