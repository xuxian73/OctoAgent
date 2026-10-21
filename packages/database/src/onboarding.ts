import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization, ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { securityContext } from "../../security/src/index.js";
import { Audit, audited } from "./security.js";

export class Onboarding {
  constructor(private db: DatabaseSync, private auth: Authorization) {
    return audited(
      this,
      db,
      auth,
      ["create", "updateSeller"],
      (_method, _args, result) => ({
        type: (result as { projectId?: string }).projectId
          ? "project"
          : "organization",
        id:
          (result as { projectId?: string; organizationId: string })
            .projectId || (result as { organizationId: string }).organizationId
      })
    );
  }
  private human(token: string) {
    const identity = this.auth.identity(token);
    if (identity.kind !== "user") throw new ForbiddenError();
    return identity.id;
  }
  list(token: string) {
    const user = this.human(token);
    const visible = (kind: "organization" | "project", id: string) => {
      try {
        this.auth.authorize(token, { kind, resourceId: id, action: "read" });
        return true;
      } catch (error) {
        if (error instanceof ForbiddenError) return false;
        throw error;
      }
    };
    const organizations = this.db
      .prepare(
        `SELECT o.id, COALESCE(n.organization_name, s.display_name, o.id) name
      FROM organizations o JOIN memberships m ON m.organization_id=o.id AND m.project_id=''
      LEFT JOIN account_onboarding n ON n.organization_id=o.id LEFT JOIN seller_profiles s ON s.organization_id=o.id WHERE m.user_id=? ORDER BY o.id`
      )
      .all(user)
      .filter(row => visible("organization", String(row.id)));
    const projects = this.db
      .prepare(
        `SELECT p.id, p.organization_id organizationId, COALESCE(n.project_name, p.id) name
      FROM projects p JOIN memberships m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN account_onboarding n ON n.project_id=p.id WHERE m.user_id=? ORDER BY p.id`
      )
      .all(user)
      .map(row => ({
        ...row,
        id: String(row.id),
        pages: this.pages(token, String(row.id), user)
      }))
      // Contract access is independently granted; project read is not required.
      .filter(row => row.pages.length || visible("project", String(row.id)));
    const sellerProfile =
      this.db
        .prepare(
          "SELECT organization_id organizationId, display_name displayName, capabilities, task_types taskTypes, bio, status FROM seller_profiles WHERE user_id=?"
        )
        .get(user) || null;
    const buyer = !!this.db
      .prepare(
        "SELECT 1 FROM account_onboarding WHERE user_id=? UNION ALL SELECT 1 FROM memberships WHERE user_id=? AND role='buyer'"
      )
      .get(user, user);
    return {
      businessRoles: [
        ...(buyer ? ["buyer"] : []),
        ...(sellerProfile ? ["seller"] : [])
      ],
      sellerProfile,
      organizations,
      projects,
      canInitialize: !this.db
        .prepare(
          "SELECT 1 FROM account_onboarding WHERE user_id=? UNION ALL SELECT 1 FROM memberships WHERE user_id=? AND project_id != ''"
        )
        .get(user, user)
    };
  }
  private pages(token: string, projectId: string, user: string) {
    const allowed = (
      action: "read" | "write",
      roles: ("buyer" | "seller")[]
    ) => {
      try {
        this.auth.authorize(
          token,
          { kind: "project", resourceId: projectId, action },
          roles
        );
        return true;
      } catch (error) {
        if (error instanceof ForbiddenError) return false;
        throw error;
      }
    };
    const pages: string[] = [];
    if (allowed("read", ["buyer"])) pages.push("requirements");
    if (allowed("read", ["buyer", "seller"])) pages.push("market");
    const contracts = this.db
      .prepare(
        "SELECT c.id, c.buyer_id, c.seller_id FROM contracts c JOIN requirements r ON r.id=c.requirement_id WHERE r.project_id=? AND (c.buyer_id=? OR c.seller_id=?)"
      )
      .all(projectId, user, user)
      .filter(row => {
        try {
          const access = this.auth.authorize(
            token,
            { kind: "contract", resourceId: String(row.id), action: "read" },
            ["buyer", "seller"]
          );
          return access.role === (row.buyer_id === user ? "buyer" : "seller");
        } catch (error) {
          if (error instanceof ForbiddenError) return false;
          throw error;
        }
      });
    if (
      contracts.length ||
      (allowed("read", ["buyer"]) && allowed("write", ["buyer"]))
    )
      pages.push("contracts");
    if (
      contracts.some(row =>
        this.db
          .prepare("SELECT 1 FROM delivery_workspaces WHERE contract_id=?")
          .get(row.id!)
      )
    )
      pages.push("workspaces");
    return pages;
  }
  updateSeller(token: string, input: unknown) {
    return this.saveSeller(token, input, true);
  }
  private saveSeller(token: string, input: unknown, editing: boolean) {
    const user = this.human(token);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RequirementError("INVALID_ONBOARDING");
    const body = input as Record<string, unknown>;
    if (
      body.role !== "seller" ||
      Object.keys(body).some(
        key =>
          !["role", "displayName", "capabilities", "taskTypes", "bio"].includes(
            key
          )
      )
    )
      throw new RequirementError("INVALID_ONBOARDING");
    for (const [key, limit] of [
      ["displayName", 80],
      ["capabilities", 500],
      ["taskTypes", 500],
      ["bio", 1000]
    ] as const) {
      const value = body[key];
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > limit ||
        /[\x00-\x1f\x7f]/.test(value)
      )
        throw new RequirementError("INVALID_ONBOARDING");
    }
    const prior = this.db
      .prepare("SELECT organization_id FROM seller_profiles WHERE user_id=?")
      .get(user);
    if (editing && !prior) throw new RequirementError("PROFILE_REQUIRED", 409);
    if (!editing && prior)
      throw new RequirementError("ALREADY_INITIALIZED", 409);
    // Only reuse an organization created by this user's buyer onboarding.
    const own = this.db
      .prepare("SELECT organization_id FROM account_onboarding WHERE user_id=?")
      .get(user);
    const organizationId = String(
      prior?.organization_id || own?.organization_id || randomUUID()
    );
    const context = securityContext.getStore();
    if (context) context.tenant = organizationId;
    if (!prior && !own) {
      this.db
        .prepare("INSERT INTO organizations VALUES (?)")
        .run(organizationId);
      this.db
        .prepare("INSERT INTO memberships VALUES (?,?, '','seller')")
        .run(user, organizationId);
      this.db
        .prepare(
          "INSERT INTO authorization_resources VALUES ('organization',?,?,NULL)"
        )
        .run(organizationId, organizationId);
      this.db
        .prepare(
          "INSERT INTO resource_grants VALUES (?,'organization',?,'read')"
        )
        .run(user, organizationId);
      const audit = new Audit(this.db);
      audit.append("membership.created", "success", {
        type: "organization",
        id: organizationId,
        targetSubject: "user:" + user
      });
      audit.append("permission.granted", "success", {
        type: "organization",
        id: organizationId,
        targetSubject: "user:" + user,
        permissionChange: {
          permission: "read",
          action: "grant",
          expiresAt: null
        }
      });
    }
    this.auth.authorize(token, {
      kind: "organization",
      resourceId: organizationId,
      action: "read"
    });
    this.db
      .prepare(
        `INSERT INTO seller_profiles VALUES (?,?,?,?,?,?,'completed')
      ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, capabilities=excluded.capabilities, task_types=excluded.task_types, bio=excluded.bio`
      )
      .run(
        user,
        organizationId,
        (body.displayName as string).trim(),
        (body.capabilities as string).trim(),
        (body.taskTypes as string).trim(),
        (body.bio as string).trim()
      );
    return { organizationId };
  }
  create(token: string, input: unknown) {
    const user = this.human(token);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RequirementError("INVALID_ONBOARDING");
    const body = input as Record<string, unknown>;
    if (body.role === "seller") return this.saveSeller(token, body, false);
    if (body.role !== undefined && body.role !== "buyer")
      throw new RequirementError("INVALID_ONBOARDING");
    if (
      Object.keys(body).some(
        key => !["role", "organizationName", "projectName"].includes(key)
      )
    )
      throw new RequirementError("INVALID_ONBOARDING");
    for (const name of [body.organizationName, body.projectName]) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 80 ||
        /[\x00-\x1f\x7f]/.test(name)
      )
        throw new RequirementError("INVALID_ONBOARDING");
    }
    if (!this.list(token).canInitialize)
      throw new RequirementError("ALREADY_INITIALIZED", 409);
    const organizationId = randomUUID();
    const projectId = randomUUID();
    this.db
      .prepare("INSERT INTO organizations(id) VALUES (?)")
      .run(organizationId);
    this.db
      .prepare("INSERT INTO projects(id,organization_id) VALUES (?,?)")
      .run(projectId, organizationId);
    this.db
      .prepare("INSERT INTO account_onboarding VALUES (?,?,?,?,?)")
      .run(
        user,
        organizationId,
        projectId,
        (body.organizationName as string).trim(),
        (body.projectName as string).trim()
      );
    const context = securityContext.getStore();
    if (context) context.tenant = organizationId;
    const audit = new Audit(this.db);
    for (const [kind, id, project] of [
      ["organization", organizationId, ""],
      ["project", projectId, projectId]
    ] as const) {
      this.db
        .prepare("INSERT INTO memberships VALUES (?,?,?,'buyer')")
        .run(user, organizationId, project);
      audit.append("membership.created", "success", {
        type: kind,
        id,
        targetSubject: "user:" + user
      });
      this.db
        .prepare("INSERT INTO authorization_resources VALUES (?,?,?,?)")
        .run(kind, id, organizationId, project || null);
      for (const action of kind === "project"
        ? (["read", "write"] as const)
        : (["read"] as const)) {
        this.db
          .prepare("INSERT INTO resource_grants VALUES (?,?,?,?)")
          .run(user, kind, id, action);
        audit.append("permission.granted", "success", {
          type: kind,
          id,
          targetSubject: "user:" + user,
          permissionChange: {
            permission: action,
            action: "grant",
            expiresAt: null
          }
        });
        // Persist these checks in the existing idempotency record for replay authorization.
        this.auth.authorize(token, { kind, resourceId: id, action }, ["buyer"]);
      }
    }
    return { organizationId, projectId };
  }
}
