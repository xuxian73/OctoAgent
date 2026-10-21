ALTER TABLE audit_events ADD COLUMN object_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE audit_events ADD COLUMN target_subject TEXT;
