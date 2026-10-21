-- Keep a durable first-use record even if membership or grants are later revoked.
CREATE TABLE account_onboarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  organization_name TEXT NOT NULL,
  project_name TEXT NOT NULL
);
