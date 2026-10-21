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
  granted(userId: string, scope: Scope): boolean {
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
