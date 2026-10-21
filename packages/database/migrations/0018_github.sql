CREATE TABLE github_connections (
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE github_deliveries (
  connection_id TEXT NOT NULL,
  local_sha TEXT NOT NULL,
  plan TEXT NOT NULL,
  evidence TEXT,
  PRIMARY KEY(connection_id, local_sha)
);
