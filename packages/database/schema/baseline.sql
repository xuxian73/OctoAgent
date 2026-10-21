-- Infrastructure only. Business tables belong to later issues.
CREATE TABLE platform_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
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

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  draft TEXT NOT NULL,
  published TEXT,
  published_attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE requirement_changes (
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  changed_fields TEXT NOT NULL,
  PRIMARY KEY (requirement_id, version)
);
-- Populated by the future bidding service, never by an untrusted HTTP caller.
CREATE TABLE requirement_participants (
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (requirement_id, user_id)
);
CREATE TABLE requirement_notifications (
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  event TEXT NOT NULL CHECK (event = 'requirement_changed'),
  FOREIGN KEY (requirement_id, version) REFERENCES requirement_changes(requirement_id, version),
  PRIMARY KEY (requirement_id, version, user_id)
);
CREATE TABLE requirement_attachments (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1))
);
CREATE TABLE requirement_confirmations (
  digest TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE bids (
 id TEXT PRIMARY KEY,
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL,
 task_version INTEGER NOT NULL,
 proposal TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'withdrawn')),
 UNIQUE(requirement_id, owner_id, version)
);
CREATE TABLE bid_confirmations (
 digest TEXT PRIMARY KEY,
 bid_id TEXT NOT NULL REFERENCES bids(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 expires_at INTEGER NOT NULL
);
CREATE TABLE market_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 actor_id TEXT NOT NULL,
 audience TEXT NOT NULL,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE contracts (
 id TEXT PRIMARY KEY,
 requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id),
 bid_id TEXT NOT NULL UNIQUE REFERENCES bids(id),
 buyer_id TEXT NOT NULL REFERENCES users(id),
 seller_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','pending_confirmation','active','paused','completed','cancelled','disputed')),
 settlement TEXT NOT NULL DEFAULT 'unsettled' CHECK(settlement IN ('unsettled','manually_confirmed'))
);
CREATE TABLE contract_versions (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 version INTEGER NOT NULL,
 terms TEXT NOT NULL,
 PRIMARY KEY(contract_id, version)
);
CREATE TABLE contract_confirmations (
 contract_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 party TEXT NOT NULL CHECK(party IN ('buyer','seller')),
 actor_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 FOREIGN KEY(contract_id, version) REFERENCES contract_versions(contract_id, version),
 PRIMARY KEY(contract_id, version, party)
);
CREATE TABLE milestones (
 id TEXT PRIMARY KEY,
 contract_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('planned','in_progress','submitted','changes_requested','accepted','rejected')),
 FOREIGN KEY(contract_id, version) REFERENCES contract_versions(contract_id, version)
);
CREATE TABLE contract_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 version INTEGER NOT NULL,
 actor_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL
);
CREATE TABLE contract_requests (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 actor_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 PRIMARY KEY(contract_id, actor_id, request_key)
);
CREATE TRIGGER contract_versions_no_update BEFORE UPDATE ON contract_versions
BEGIN SELECT RAISE(ABORT, 'Immutable contract version'); END;
CREATE TRIGGER contract_versions_no_delete BEFORE DELETE ON contract_versions
BEGIN SELECT RAISE(ABORT, 'Immutable contract version'); END;
CREATE TRIGGER contract_events_no_update BEFORE UPDATE ON contract_events
BEGIN SELECT RAISE(ABORT, 'Immutable contract event'); END;
CREATE TRIGGER contract_events_no_delete BEFORE DELETE ON contract_events
BEGIN SELECT RAISE(ABORT, 'Immutable contract event'); END;
CREATE TABLE delivery_workspaces (
 contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
 task_version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT '{"branches":{},"commits":[],"checks":[],"pullRequests":[],"artifacts":[],"discussions":[],"risks":[],"deployments":[],"submissions":[]}'
);
CREATE TRIGGER active_workspace AFTER UPDATE OF status ON contracts WHEN NEW.status = 'active'
BEGIN
 INSERT OR IGNORE INTO delivery_workspaces(contract_id, task_version)
 SELECT NEW.id, task_version FROM bids WHERE id = NEW.bid_id;
END;
INSERT INTO delivery_workspaces(contract_id, task_version)
 SELECT c.id, b.task_version FROM contracts c JOIN bids b ON b.id = c.bid_id WHERE c.status = 'active';
CREATE TABLE delivery_permissions (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 actor_id TEXT NOT NULL,
 permission TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(contract_id, actor_id, permission)
);
CREATE TABLE delivery_requests (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 actor_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(contract_id, actor_id, request_key)
);
CREATE TABLE mcp_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(actor_id, request_id)
);
CREATE TRIGGER mcp_requests_no_update BEFORE UPDATE ON mcp_requests
BEGIN SELECT RAISE(ABORT, 'immutable MCP request'); END;
CREATE TRIGGER mcp_requests_no_delete BEFORE DELETE ON mcp_requests
BEGIN SELECT RAISE(ABORT, 'immutable MCP request'); END;
CREATE TABLE audit_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 scope TEXT NOT NULL,
 object_id TEXT NOT NULL,
 event TEXT NOT NULL,
 result TEXT NOT NULL,
 summary TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;
CREATE TABLE business_requests (
 actor_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 scopes TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE callback_nonces (
 source TEXT NOT NULL,
 nonce TEXT NOT NULL,
 PRIMARY KEY(source,nonce)
);
CREATE TRIGGER audit_no_replace BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE sequence = NEW.sequence)
BEGIN SELECT RAISE(ABORT, 'immutable audit'); END;

ALTER TABLE audit_events ADD COLUMN object_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE audit_events ADD COLUMN target_subject TEXT;

ALTER TABLE audit_events ADD COLUMN permission TEXT;
ALTER TABLE audit_events ADD COLUMN permission_action TEXT CHECK (permission_action IN ('grant', 'revoke'));
ALTER TABLE audit_events ADD COLUMN permission_expires_at INTEGER;

-- Password material is isolated from business records; sessions remain digest-only.
CREATE TABLE local_accounts (
  username TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
-- Keep a durable first-use record even if membership or grants are later revoked.
CREATE TABLE account_onboarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  organization_name TEXT NOT NULL,
  project_name TEXT NOT NULL
);
