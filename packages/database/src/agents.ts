import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Authorization,
  ForbiddenError,
  Scope,
  tokenDigest,
  MAX_AGENT_TTL_MS
} from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { SqliteIdentityStore } from "./identity.js";
import { audited } from "./security.js";

export class Agents {
  constructor(private db: DatabaseSync, private auth: Authorization) {
    return audited(
      this,
      db,
      auth,
      ["list", "create", "issue", "revoke"],
      (method, args, result) => {
        const value = result as { id?: string };
        return {
          type:
            method === "issue" || method === "revoke" ? "credential" : "agent",
          id: method === "revoke" ? String(args[2]) : value.id || "self",
          ...(method === "issue" || method === "revoke"
            ? { targetSubject: "agent:" + String(args[1]) }
            : {})
        };
      }
    );
  }
  private owner(session: string) {
    const identity = this.auth.identity(session);
    if (identity.kind !== "user") throw new ForbiddenError();
    return identity.id;
  }
  private owned(session: string, id: string) {
    const owner = this.owner(session);
    const agent = new SqliteIdentityStore(this.db).agent(id);
    if (!agent || agent.responsibleUserId !== owner) throw new ForbiddenError();
    return agent;
  }
  private fields(input: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(input).some(key => !allowed.includes(key)))
      throw new RequirementError("INVALID_FIELDS");
  }
  list(session: string) {
    const owner = this.owner(session);
    const store = new SqliteIdentityStore(this.db);
    const scopes = this.db
      .prepare(
        "SELECT resource_kind, resource_id, action FROM resource_grants WHERE user_id=? AND action != 'delegate'"
      )
      .all(owner)
      .map(
        row =>
          ({
            kind: row.resource_kind,
            resourceId: row.resource_id,
            action: row.action
          } as Scope)
      )
      .filter(scope => {
        try {
          this.auth.authorize(session, scope);
          this.auth.authorize(session, { ...scope, action: "delegate" });
          return true;
        } catch {
          return false;
        }
      });
    return {
      responsibleUserId: owner,
      maxTtlMs: MAX_AGENT_TTL_MS,
      scopes,
      agents: this.db
        .prepare(
          "SELECT id FROM agents WHERE responsible_user_id=? ORDER BY id"
        )
        .all(owner)
        .map(row => ({
          ...store.agent(String(row.id))!,
          credentials: this.db
            .prepare(
              "SELECT digest FROM credentials WHERE agent_id=? ORDER BY expires_at DESC"
            )
            .all(row.id!)
            .map(credential => {
              const value = store.credential(String(credential.digest))!;
              return {
                id: value.digest,
                scopes: value.scopes,
                expiresAt: value.expiresAt,
                revoked: value.revoked
              };
            })
        }))
    };
  }
  create(session: string, input: Record<string, unknown>) {
    const owner = this.owner(session);
    this.fields(input, ["kind", "capabilities"]);
    if (
      !["buyer", "seller", "orchestrator"].includes(String(input.kind)) ||
      !Array.isArray(input.capabilities) ||
      input.capabilities.length > 20 ||
      input.capabilities.some(
        value => typeof value !== "string" || !value.trim() || value.length > 80
      )
    )
      throw new RequirementError("INVALID_AGENT");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO agents VALUES (?,?,?,?)")
      .run(
        id,
        owner,
        String(input.kind),
        JSON.stringify([
          ...new Set(input.capabilities.map(value => value.trim()))
        ])
      );
    return new SqliteIdentityStore(this.db).agent(id)!;
  }
  issue(session: string, id: string, input: Record<string, unknown>) {
    const agent = this.owned(session, id);
    this.fields(input, ["scopes", "ttlMs", "confirmed"]);
    if (input.confirmed !== true)
      throw new RequirementError("CONFIRMATION_REQUIRED");
    if (!Array.isArray(input.scopes) || typeof input.ttlMs !== "number")
      throw new RequirementError("INVALID_CREDENTIAL");
    for (const scope of input.scopes) {
      if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw new RequirementError("INVALID_SCOPE");
      this.fields(scope, ["kind", "resourceId", "action"]);
    }
    const token = this.auth.issueAgentToken(
      session,
      id,
      input.scopes as Scope[],
      input.ttlMs
    );
    const value = new SqliteIdentityStore(this.db).credential(
      tokenDigest(token)
    )!;
    // Never use the business request replay cache for this result.
    return {
      token,
      id: value.digest,
      scopes: value.scopes,
      expiresAt: value.expiresAt,
      responsibleUserId: agent.responsibleUserId
    };
  }
  revoke(session: string, id: string, digest: string) {
    this.owned(session, id);
    if (new SqliteIdentityStore(this.db).credential(digest)?.agentId !== id)
      throw new ForbiddenError();
    this.auth.revoke(session, digest);
    return { revoked: true };
  }
}
