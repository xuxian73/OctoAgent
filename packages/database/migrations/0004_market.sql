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
