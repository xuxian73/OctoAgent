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
