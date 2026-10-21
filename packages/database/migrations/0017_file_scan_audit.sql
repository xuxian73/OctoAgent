CREATE TABLE file_scan_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 file_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 checksum TEXT NOT NULL,
 scanner TEXT NOT NULL,
 actor TEXT NOT NULL,
 event TEXT NOT NULL,
 status TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER file_scan_events_no_update BEFORE UPDATE ON file_scan_events
BEGIN SELECT RAISE(ABORT, 'Immutable scan audit'); END;
CREATE TRIGGER file_scan_events_no_delete BEFORE DELETE ON file_scan_events
BEGIN SELECT RAISE(ABORT, 'Immutable scan audit'); END;
