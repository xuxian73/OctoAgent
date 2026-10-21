import { DatabaseSync } from "node:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Authorization, Scope } from "../../auth/src/index.js";
import {
  AuditObject,
  digest,
  requestContext,
  securityContext
} from "../../security/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
export class Audit {
  constructor(private db: DatabaseSync) {}
  append(event: string, result: string, object?: AuditObject) {
    const c = securityContext.getStore() || requestContext();
    this.db
      .prepare(
        "INSERT INTO audit_events(request_id,actor_id,tenant_id,scope,object_id,event,result,summary,created_at,object_type,target_subject) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        c.requestId,
        c.actor || "anonymous",
        c.tenant || "unknown",
        JSON.stringify(c.scopes),
        object?.id || "none",
        c.operation ? event + ":" + c.operation : event,
        result,
        "业务调用；不记录输入、输出或错误原文",
        Date.now(),
        object?.type || "none",
        object?.targetSubject || null
      );
  }
}
export function audited<T extends object>(
  target: T,
  db: DatabaseSync,
  auth: Authorization,
  names: string[],
  objectFor?: (method: string, args: unknown[], result: unknown) => AuditObject
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const fn = Reflect.get(object, property, receiver);
      if (
        typeof property !== "string" ||
        !names.includes(property) ||
        typeof fn !== "function"
      )
        return fn;
      return (...args: unknown[]) => {
        const outer = securityContext.getStore();
        const c = {
          ...(outer || requestContext()),
          key: outer?.scopes.length ? undefined : outer?.key,
          object: undefined as AuditObject | undefined,
          scopes: [] as Scope[]
        };
        return securityContext.run(c, () => {
          const command =
            property === "command"
              ? (args[2] as { action?: unknown })?.action
              : undefined;
          const actions = [
            "authorize",
            "deploy",
            "migrate",
            "delete",
            "expand_permissions",
            "create_workspace_branch",
            "commit",
            "run_check",
            "create_pull_request",
            "upload_artifact",
            "submit_milestone",
            "discuss",
            "report_blocker",
            "confirm",
            "change",
            "transition",
            "milestone",
            "review_draft",
            "settlement"
          ];
          const event =
            target.constructor.name +
            "." +
            property +
            (typeof command === "string" && actions.includes(command)
              ? "." + command
              : "");
          const nested = db.isTransaction;
          db.exec(nested ? "SAVEPOINT audited_operation" : "BEGIN IMMEDIATE");
          try {
            let result: unknown;
            const token = typeof args[0] === "string" ? args[0] : "";
            const actor = ["publicView", "call", "resource"].includes(property)
              ? "anonymous"
              : auth.identity(token);
            c.actor =
              typeof actor === "string" ? actor : actor.kind + ":" + actor.id;
            const key =
              c.key &&
              [
                "create",
                "draft",
                "clarify",
                "question",
                "supplement",
                "answer",
                "addAttachment"
              ].includes(property)
                ? digest(c.key)
                : undefined;
            const fingerprint = digest(JSON.stringify([event, args.slice(1)]));
            const prior = key
              ? db
                  .prepare(
                    "SELECT * FROM business_requests WHERE actor_id=? AND request_key=?"
                  )
                  .get(c.actor, key)
              : undefined;
            if (prior) {
              if (prior.fingerprint !== fingerprint)
                throw new RequirementError("REQUEST_KEY_REUSED", 409);
              for (const scope of JSON.parse(String(prior.scopes)) as Scope[])
                auth.authorize(token, scope, [
                  (scope as Scope & { role: "buyer" | "seller" | "admin" }).role
                ]);
              result = JSON.parse(String(prior.result));
            } else {
              result = fn.apply(object, args);
              if (key)
                db.prepare(
                  "INSERT INTO business_requests VALUES (?,?,?,?,?)"
                ).run(
                  c.actor,
                  key,
                  fingerprint,
                  JSON.stringify(c.scopes),
                  JSON.stringify(result)
                );
            }
            const envelopeId = (result as { request_id?: unknown })?.request_id;
            if (typeof envelopeId === "string") c.requestId = envelopeId;
            const rejected = !!(result as { error?: unknown })?.error;
            if (!rejected && objectFor)
              c.object = objectFor(property, args, result);
            new Audit(db).append(
              event,
              (result as { error?: unknown })?.error
                ? "rejected"
                : prior
                ? "replayed"
                : "success",
              rejected ? undefined : c.object
            );
            db.exec(nested ? "RELEASE audited_operation" : "COMMIT");
            if (outer && !rejected && c.object) outer.object = c.object;
            return result;
          } catch (error) {
            db.exec(
              nested
                ? "ROLLBACK TO audited_operation; RELEASE audited_operation"
                : "ROLLBACK"
            );
            new Audit(db).append(event, "rejected");
            throw error;
          } finally {
            if (outer) {
              outer.scopes.push(...c.scopes);
              if (c.tenant) outer.tenant = c.tenant;
            }
          }
        });
      };
    }
  });
}
// No production callback endpoint exists. Adapters must verify before applying effects.
export class CallbackVerifier {
  constructor(
    private db: DatabaseSync,
    private secret: Uint8Array,
    private now = Date.now
  ) {}
  verify(
    source: string,
    timestamp: number,
    nonce: string,
    body: Uint8Array,
    signature: string
  ): void {
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(this.now() - timestamp) > 300000 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new RequirementError("INVALID_CALLBACK", 403);
    const expected = createHmac("sha256", this.secret)
      .update(
        JSON.stringify([
          source,
          timestamp,
          nonce,
          digest(Buffer.from(body).toString("base64"))
        ])
      )
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new RequirementError("INVALID_CALLBACK", 403);
    try {
      this.db
        .prepare("INSERT INTO callback_nonces VALUES (?,?)")
        .run(digest(source), digest(nonce));
    } catch {
      throw new RequirementError("CALLBACK_REPLAY", 409);
    }
  }
}
