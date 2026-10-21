import { requestContext, securityContext } from "../../security/src/index.js";
import { createHash, randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import {
  Action,
  Credential,
  IdentityStore,
  Resource,
  ResourceKind,
  Role,
  Scope
} from "./model.js";

export * from "./model.js";
export class ForbiddenError extends Error {
  constructor() {
    super("无权访问");
  }
}
const deny = (): never => {
  throw new ForbiddenError();
};
export const permissionMatrix: Readonly<Record<Action, readonly Role[]>> = {
  read: ["buyer", "seller", "admin"],
  write: ["buyer", "seller"],
  delegate: ["buyer", "seller", "admin"]
};
export const resourceKinds: readonly ResourceKind[] = [
  "market",
  "task",
  "organization",
  "project",
  "dispute",
  "contract",
  "workspace",
  "repository",
  "secret",
  "production"
];
export const MAX_AGENT_TTL_MS = 15 * 60 * 1000;
export const tokenDigest = (token: string): string =>
  createHash("sha256")
    .update(token)
    .digest("hex");
export interface AuditRecord {
  event: "issued" | "revoked";
  tokenDigest: string;
}
export interface Identity {
  kind: "user" | "agent";
  id: string;
  responsibleUserId: string;
}
function validScope(scope: Scope): boolean {
  return (
    !!scope &&
    resourceKinds.includes(scope.kind) &&
    typeof scope.resourceId === "string" &&
    scope.resourceId.length > 0 &&
    Object.hasOwn(permissionMatrix, scope.action)
  );
}
function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.kind === right.kind &&
    left.resourceId === right.resourceId &&
    left.action === right.action
  );
}

export class Authorization {
  constructor(
    private readonly store: IdentityStore,
    private readonly now: () => number = Date.now,
    private readonly audit: (event: AuditRecord) => void = () => {}
  ) {}

  // Trusted server-side provisioning boundary, never exposed as a login endpoint.
  // The local login service verifies the password before calling this method.
  issueUserSession(userId: string, ttlMs = 60 * 60 * 1000): string {
    if (!this.store.user(userId)) return deny();
    return this.issue(userId, null, [], ttlMs, 8 * 60 * 60 * 1000);
  }

  private issue(
    userId: string | null,
    agentId: string | null,
    scopes: Scope[],
    ttlMs: number,
    max: number
  ): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > max)
      return deny();
    const token = randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);
    this.store.saveCredential({
      digest,
      userId,
      agentId,
      scopes,
      expiresAt: this.now() + ttlMs,
      revoked: false
    });
    this.audit({ event: "issued", tokenDigest: digest });
    return token;
  }

  private authenticate(
    token: string
  ): { identity: Identity; credential: Credential } {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return deny();
    const credential = this.store.credential(tokenDigest(token));
    if (!credential || credential.revoked || credential.expiresAt <= this.now())
      return deny();
    if (credential.agentId) {
      const agent = this.store.agent(credential.agentId);
      if (
        !agent ||
        !agent.responsibleUserId ||
        !this.store.user(agent.responsibleUserId)
      )
        return deny();
      return {
        credential,
        identity: {
          kind: "agent",
          id: agent.id,
          responsibleUserId: agent.responsibleUserId
        }
      };
    }
    if (!credential.userId || !this.store.user(credential.userId))
      return deny();
    return {
      credential,
      identity: {
        kind: "user",
        id: credential.userId,
        responsibleUserId: credential.userId
      }
    };
  }

  authorize(
    token: string,
    scope: Scope,
    roles?: readonly Role[]
  ): { identity: Identity; resource: Resource; role: Role } {
    if (!validScope(scope)) return deny();
    const { identity, credential } = this.authenticate(token);
    const resource = this.store.resource(scope.kind, scope.resourceId);
    if (
      !resource ||
      (identity.kind === "agent" && resource.allowAgents === false)
    )
      return deny();
    const role = this.store.role(identity.responsibleUserId, resource);
    if (
      !role ||
      !permissionMatrix[scope.action].includes(role) ||
      (roles && !roles.includes(role))
    )
      return deny();
    if (!this.store.granted(identity.responsibleUserId, scope, this.now()))
      return deny();
    if (
      identity.kind === "agent" &&
      (scope.action === "delegate" ||
        !credential.scopes.some(value => sameScope(value, scope)))
    )
      return deny();
    const context = securityContext.getStore();
    if (context) {
      context.actor = identity.kind + ":" + identity.id;
      context.tenant = resource.organizationId;
      if (!context.scopes.some(s => sameScope(s as Scope, scope)))
        context.scopes.push({ ...scope, role } as Scope);
    }
    return { identity, resource, role };
  }

  identity(token: string): Identity {
    return this.authenticate(token).identity;
  }

  // MCP discovery and self resources authenticate without broadening any scope.
  agentIdentity(token: string) {
    const { identity, credential } = this.authenticate(token);
    if (identity.kind !== "agent") throw new ForbiddenError();
    const context = securityContext.getStore();
    if (context) context.actor = "agent:" + identity.id;
    const agent = this.store.agent(identity.id)!;
    return {
      ...identity,
      capabilities: [...agent.capabilities],
      scopes: credential.scopes.filter(scope => {
        try {
          this.authorize(token, scope);
          return true;
        } catch {
          return false;
        }
      })
    };
  }

  issueAgentToken(
    session: string,
    agentId: string,
    scopes: Scope[] = [],
    ttlMs = MAX_AGENT_TTL_MS
  ): string {
    const { identity } = this.authenticate(session);
    const agent = this.store.agent(agentId);
    if (
      identity.kind !== "user" ||
      !agent ||
      agent.responsibleUserId !== identity.id ||
      !Array.isArray(scopes) ||
      scopes.length > 100
    )
      return deny();
    for (const scope of scopes) {
      if (!validScope(scope) || scope.action === "delegate") return deny();
      this.authorize(session, scope);
      this.authorize(session, { ...scope, action: "delegate" });
    }
    return securityContext.run(
      {
        ...(securityContext.getStore() || requestContext()),
        actor: "user:" + identity.id,
        scopes
      },
      () => this.issue(null, agentId, scopes, ttlMs, MAX_AGENT_TTL_MS)
    );
  }

  // Owners revoke their credentials; platform admins can revoke, never read by default.
  revoke(session: string, digest: string): void {
    const { identity } = this.authenticate(session);
    const target = this.store.credential(digest);
    const owner =
      target?.userId ||
      (target?.agentId
        ? this.store.agent(target.agentId)?.responsibleUserId
        : undefined);
    if (
      identity.kind !== "user" ||
      !target ||
      (owner !== identity.id &&
        this.store.user(identity.id)?.platformRole !== "admin")
    )
      return deny();
    securityContext.run(
      {
        ...(securityContext.getStore() || requestContext()),
        actor: "user:" + identity.id,
        scopes: target.scopes
      },
      () => this.store.revoke(digest)
    );
    this.audit({ event: "revoked", tokenDigest: target.digest });
  }
}

// Inspect raw headers: Node may discard duplicate Authorization headers.
// Request IDs and caller-supplied user/role headers never establish identity.
export function bearerToken(request: IncomingMessage): string {
  if (sessionCookie(request) !== undefined) return deny();
  const values: string[] = [];
  const raw = request.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "authorization")
      values.push(raw[i + 1] || "");
  }
  if (values.length !== 1) return deny();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(values[0]!);
  return match?.[1] || deny();
}

export function authorizeRequest(
  auth: Authorization,
  request: IncomingMessage,
  scope: Scope,
  roles?: readonly Role[]
): ReturnType<Authorization["authorize"]> {
  return auth.authorize(webToken(request), scope, roles);
}

export const SESSION_COOKIE = "octo_session";
export function sessionCookie(request: IncomingMessage): string | undefined {
  const values: string[] = [];
  const raw = request.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() !== "cookie") continue;
    for (const part of (raw[i + 1] || "").split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === SESSION_COOKIE) values.push(value.join("="));
    }
  }
  if (values.length > 1) return deny();
  return values[0];
}
export const csrfToken = (token: string): string =>
  tokenDigest("csrf:" + token);
export function webToken(request: IncomingMessage): string {
  const cookie = sessionCookie(request);
  if (cookie === undefined) return bearerToken(request);
  if (
    (request.rawHeaders || []).some(
      (v, i) => i % 2 === 0 && v.toLowerCase() === "authorization"
    )
  )
    return deny();
  if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) return deny();
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method || "") &&
    request.headers["x-csrf-token"] !== csrfToken(cookie)
  )
    return deny();
  return cookie;
}
