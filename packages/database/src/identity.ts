import { Audit } from "./security.js";
import { requestContext, securityContext } from "../../security/src/index.js";
import { DatabaseSync } from "node:sqlite";
import {
  Agent,
  Credential,
  IdentityStore,
  Resource,
  ResourceKind,
  Role,
  Scope,
  User
} from "../../auth/src/model.js";

export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly db: DatabaseSync) {}
  user(id: string): User | undefined {
    const row = this.db
      .prepare("SELECT id, platform_role FROM users WHERE id = ?")
      .get(id);
    return row
      ? {
          id: String(row.id),
          platformRole: row.platform_role as User["platformRole"]
        }
      : undefined;
  }
  agent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row
      ? {
          id: String(row.id),
          responsibleUserId: String(row.responsible_user_id),
          kind: row.kind as Agent["kind"],
          capabilities: JSON.parse(String(row.capabilities))
        }
      : undefined;
  }
  resource(kind: ResourceKind, id: string): Resource | undefined {
    if (kind === "market" && id === "public")
      return { kind, id, organizationId: "market", projectId: null };
    if (kind === "task") {
      const row = this.db
        .prepare("SELECT id, market FROM market_publications WHERE id=?")
        .get(id);
      return row
        ? {
            kind,
            id,
            organizationId: "market",
            projectId: null,
            allowAgents: JSON.parse(String(row.market)).allowAgents
          }
        : undefined;
    }
    if (kind === "dispute") {
      const row = this.db
        .prepare(
          "SELECT r.organization_id, r.project_id FROM dispute_cases d JOIN authorization_resources r ON r.kind='contract' AND r.id=d.contract_id WHERE d.id=?"
        )
        .get(id);
      return row
        ? {
            kind,
            id,
            organizationId: String(row.organization_id),
            projectId: String(row.project_id)
          }
        : undefined;
    }
    const row = this.db
      .prepare(
        "SELECT * FROM authorization_resources WHERE kind = ? AND id = ?"
      )
      .get(kind, id);
    return row
      ? {
          kind,
          id,
          organizationId: String(row.organization_id),
          projectId: row.project_id === null ? null : String(row.project_id)
        }
      : undefined;
  }
  role(userId: string, resource: Resource): Role | undefined {
    if (resource.kind === "market" || resource.kind === "task")
      return this.db
        .prepare(
          `SELECT 1 FROM seller_profiles s
        JOIN memberships m ON m.user_id=s.user_id AND m.organization_id=s.organization_id AND m.project_id=''
        JOIN resource_grants g ON g.user_id=s.user_id AND g.resource_kind='organization'
          AND g.resource_id=s.organization_id AND g.action='read'
        WHERE s.user_id=? AND s.status='completed'`
        )
        .get(userId)
        ? "seller"
        : undefined;
    if (
      resource.kind === "contract" &&
      this.db.prepare("SELECT 1 FROM contracts WHERE id=?").get(resource.id)
    )
      return this.db
        .prepare(
          "SELECT role FROM contract_parties WHERE contract_id=? AND user_id=?"
        )
        .get(resource.id, userId)?.role as Role | undefined;
    // Project access requires BOTH organization membership and explicit project membership.
    const organization = this.db
      .prepare(
        "SELECT role FROM memberships WHERE user_id = ? AND organization_id = ? AND project_id = ''"
      )
      .get(userId, resource.organizationId);
    if (!organization) return undefined;
    if (!resource.projectId) return organization.role as Role;
    return this.db
      .prepare(
        "SELECT role FROM memberships WHERE user_id = ? AND organization_id = ? AND project_id = ?"
      )
      .get(userId, resource.organizationId, resource.projectId)?.role as
      | Role
      | undefined;
  }
  granted(userId: string, scope: Scope, now = Date.now()): boolean {
    if (scope.kind === "contract" && scope.action === "delegate") {
      const explicit = this.db
        .prepare(
          "SELECT expires_at FROM delivery_permissions WHERE contract_id=? AND actor_id=? AND permission='delegate'"
        )
        .get(scope.resourceId, userId);
      if (explicit) return Number(explicit.expires_at) > now;
    }
    if (scope.kind === "market")
      return scope.resourceId === "public" && scope.action !== "write";
    if (scope.kind === "task") {
      const row = this.db
        .prepare("SELECT market FROM market_publications WHERE id=?")
        .get(scope.resourceId);
      if (!row) return false;
      const participation = this.db
        .prepare(
          "SELECT revoked FROM market_participations WHERE requirement_id=? AND user_id=?"
        )
        .get(scope.resourceId, userId);
      return (
        participation?.revoked !== 1 &&
        (Number(JSON.parse(String(row.market)).deadline) > now ||
          !!participation)
      );
    }
    if (scope.kind === "dispute")
      return (
        scope.action === "read" &&
        !!this.db
          .prepare(
            "SELECT 1 FROM dispute_grants g JOIN users u ON u.id=g.admin_id JOIN dispute_cases d ON d.id=g.case_id JOIN contracts c ON c.id=d.contract_id WHERE g.case_id=? AND g.admin_id=? AND u.platform_role='admin' AND c.status='disputed' AND g.revoked_at IS NULL AND g.expires_at>? AND g.created_at<=?"
          )
          .get(scope.resourceId, userId, now, now)
      );
    return !!this.db
      .prepare(
        "SELECT 1 FROM resource_grants WHERE user_id = ? AND resource_kind = ? AND resource_id = ? AND action = ?"
      )
      .get(userId, scope.kind, scope.resourceId, scope.action);
  }
  credential(digest: string): Credential | undefined {
    const row = this.db
      .prepare("SELECT * FROM credentials WHERE digest = ?")
      .get(digest);
    return row
      ? {
          digest,
          userId: row.user_id === null ? null : String(row.user_id),
          agentId: row.agent_id === null ? null : String(row.agent_id),
          expiresAt: Number(row.expires_at),
          revoked: row.revoked === 1,
          scopes: JSON.parse(String(row.scopes))
        }
      : undefined;
  }
  private credentialChange(
    value: Credential,
    event: string,
    change: () => void
  ): void {
    const current = securityContext.getStore();
    const context = current || {
      ...requestContext(),
      actor: value.agentId ? "agent:" + value.agentId : "user:" + value.userId,
      tenant: "identity",
      scopes: value.scopes
    };
    securityContext.run(context, () => {
      this.db.exec("SAVEPOINT credential_change");
      try {
        change();
        new Audit(this.db).append(event, "success", {
          type: "credential",
          id: value.digest,
          targetSubject: value.agentId
            ? "agent:" + value.agentId
            : "user:" + value.userId
        });
        this.db.exec("RELEASE credential_change");
      } catch (error) {
        this.db.exec(
          "ROLLBACK TO credential_change; RELEASE credential_change"
        );
        throw error;
      }
    });
  }
  saveCredential(value: Credential): void {
    this.credentialChange(value, "credential.issued", () => {
      this.db
        .prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          value.digest,
          value.userId,
          value.agentId,
          value.expiresAt,
          Number(value.revoked),
          JSON.stringify(value.scopes)
        );
    });
  }
  revoke(digest: string): void {
    const value = this.credential(digest);
    if (!value) return;
    this.credentialChange(value, "credential.revoked", () => {
      this.db
        .prepare("UPDATE credentials SET revoked = 1 WHERE digest = ?")
        .run(digest);
    });
  }
}
