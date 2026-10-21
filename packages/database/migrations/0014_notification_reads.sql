CREATE TABLE requirement_notification_reads (
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (requirement_id, version, user_id),
  FOREIGN KEY (requirement_id, version, user_id) REFERENCES requirement_notifications(requirement_id, version, user_id)
);
