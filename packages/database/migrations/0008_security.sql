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
