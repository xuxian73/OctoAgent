CREATE TABLE zip_deliveries (
 id TEXT PRIMARY KEY,
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 version INTEGER NOT NULL,
 milestone_id TEXT NOT NULL REFERENCES milestones(id),
 delivery_version INTEGER NOT NULL,
 file_id TEXT NOT NULL UNIQUE REFERENCES private_files(id),
 responsible_user TEXT NOT NULL,
 summary TEXT NOT NULL,
 instructions TEXT NOT NULL,
 known_issues TEXT NOT NULL,
 checksum TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(milestone_id, delivery_version)
);
CREATE TRIGGER zip_deliveries_immutable BEFORE UPDATE ON zip_deliveries
BEGIN SELECT RAISE(ABORT, 'Immutable ZIP delivery'); END;
CREATE TRIGGER zip_deliveries_no_delete BEFORE DELETE ON zip_deliveries
BEGIN SELECT RAISE(ABORT, 'Immutable ZIP delivery'); END;
