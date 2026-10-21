CREATE TABLE github_confirmations (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  binding TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0
);
