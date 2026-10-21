ALTER TABLE audit_events ADD COLUMN permission TEXT;
ALTER TABLE audit_events ADD COLUMN permission_action TEXT CHECK (permission_action IN ('grant', 'revoke'));
ALTER TABLE audit_events ADD COLUMN permission_expires_at INTEGER;
