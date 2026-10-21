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
