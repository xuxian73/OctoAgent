export type Role = "buyer" | "seller" | "admin";
export type ResourceKind =
  | "market"
  | "task"
  | "organization"
  | "project"
  | "dispute"
  | "contract"
  | "workspace"
  | "repository"
  | "secret"
  | "production";
export type Action = "read" | "write" | "delegate";
export interface Scope {
  kind: ResourceKind;
  resourceId: string;
  action: Action;
}
export interface Resource {
  allowAgents?: boolean;
  kind: ResourceKind;
  id: string;
  organizationId: string;
  projectId: string | null;
}
export interface User {
  id: string;
  platformRole: "member" | "admin";
}
export interface Agent {
  id: string;
  responsibleUserId: string;
  kind: "buyer" | "seller" | "orchestrator";
  capabilities: string[];
}
export interface Credential {
  digest: string;
  userId: string | null;
  agentId: string | null;
  expiresAt: number;
  revoked: boolean;
  scopes: Scope[];
}
export interface IdentityStore {
  user(id: string): User | undefined;
  agent(id: string): Agent | undefined;
  resource(kind: ResourceKind, id: string): Resource | undefined;
  role(userId: string, resource: Resource): Role | undefined;
  granted(userId: string, scope: Scope, now?: number): boolean;
  credential(digest: string): Credential | undefined;
  saveCredential(credential: Credential): void;
  revoke(digest: string): void;
}
