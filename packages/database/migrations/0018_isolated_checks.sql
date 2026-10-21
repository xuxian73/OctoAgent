CREATE TABLE isolated_checks (
 id TEXT PRIMARY KEY,
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 credential_digest TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 sha TEXT NOT NULL,
 kind TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 status TEXT NOT NULL,
 result TEXT NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX isolated_checks_queue ON isolated_checks(status);
