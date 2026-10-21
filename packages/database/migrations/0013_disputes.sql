CREATE TABLE dispute_cases (
 id TEXT PRIMARY KEY NOT NULL,
 contract_id TEXT NOT NULL UNIQUE REFERENCES contracts(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL
);
CREATE TABLE dispute_grants (
 id TEXT PRIMARY KEY NOT NULL,
 case_id TEXT NOT NULL REFERENCES dispute_cases(id),
 admin_id TEXT NOT NULL REFERENCES users(id),
 granted_by TEXT NOT NULL REFERENCES users(id),
 scope TEXT NOT NULL CHECK (scope = 'audit_and_evidence:read'),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
 revoked_at INTEGER,
 revoked_by TEXT REFERENCES users(id)
);
CREATE TABLE dispute_evidence (
 id TEXT PRIMARY KEY NOT NULL,
 case_id TEXT NOT NULL REFERENCES dispute_cases(id),
 submitted_by TEXT NOT NULL REFERENCES users(id),
 party TEXT NOT NULL CHECK (party IN ('buyer', 'seller')),
 event_sequence INTEGER NOT NULL REFERENCES contract_events(sequence),
 created_at INTEGER NOT NULL,
 UNIQUE(case_id, submitted_by, event_sequence)
);
