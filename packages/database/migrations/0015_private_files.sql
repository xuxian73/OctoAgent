CREATE TABLE private_files (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('requirement','artifact')),
 resource_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 milestone_id TEXT NOT NULL,
 sha TEXT NOT NULL,
 actor TEXT NOT NULL,
 responsible_user TEXT NOT NULL,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 name TEXT NOT NULL,
 mime TEXT NOT NULL,
 size INTEGER NOT NULL,
 checksum TEXT NOT NULL,
 scan_status TEXT NOT NULL CHECK(scan_status IN ('quarantined','clean','infected','failed','unverifiable')),
 scanner TEXT NOT NULL,
 simulated INTEGER NOT NULL,
 bytes BLOB NOT NULL,
 UNIQUE(actor, request_key)
);
CREATE TRIGGER private_files_immutable BEFORE UPDATE OF id, kind, resource_id, version, revision, milestone_id, sha, actor, responsible_user, request_key, fingerprint, name, mime, size, checksum, bytes ON private_files
BEGIN SELECT RAISE(ABORT, 'Immutable file object'); END;
