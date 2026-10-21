CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  platform_role TEXT NOT NULL DEFAULT 'member' CHECK (platform_role IN ('member', 'admin'))
);
CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  UNIQUE (id, organization_id)
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'admin')),
  PRIMARY KEY (user_id, organization_id, project_id)
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  responsible_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('buyer', 'seller', 'orchestrator')),
  capabilities TEXT NOT NULL DEFAULT '[]'
);
-- Authorization references only; contract/workspace lifecycle belongs to later issues.
CREATE TABLE authorization_resources (
  kind TEXT NOT NULL CHECK (kind IN ('organization', 'project', 'contract', 'workspace', 'repository', 'secret', 'production')),
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  PRIMARY KEY (kind, id)
);
CREATE TABLE resource_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'write', 'delegate')),
  FOREIGN KEY (resource_kind, resource_id) REFERENCES authorization_resources(kind, id),
  PRIMARY KEY (user_id, resource_kind, resource_id, action)
);
CREATE TABLE credentials (
  digest TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id),
  agent_id TEXT REFERENCES agents(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  scopes TEXT NOT NULL,
  CHECK ((user_id IS NULL) != (agent_id IS NULL))
);
-- Responsibility transfer requires a new Agent identity and fresh credentials.
CREATE TRIGGER agent_responsibility_immutable
BEFORE UPDATE OF responsible_user_id ON agents
WHEN NEW.responsible_user_id != OLD.responsible_user_id
BEGIN
  SELECT RAISE(ABORT, 'Agent responsibility is immutable');
END;
CREATE TRIGGER membership_project_insert
BEFORE INSERT ON memberships
WHEN NEW.project_id != '' AND NOT EXISTS (
  SELECT 1 FROM projects WHERE id = NEW.project_id AND organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid project membership');
END;
CREATE TRIGGER membership_project_update
BEFORE UPDATE ON memberships
WHEN NEW.project_id != '' AND NOT EXISTS (
  SELECT 1 FROM projects WHERE id = NEW.project_id AND organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid project membership');
END;
