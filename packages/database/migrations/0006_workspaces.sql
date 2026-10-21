CREATE TABLE delivery_workspaces (
 contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
 task_version INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT '{"branches":{},"commits":[],"checks":[],"pullRequests":[],"artifacts":[],"discussions":[],"risks":[],"deployments":[],"submissions":[]}'
);
CREATE TRIGGER active_workspace AFTER UPDATE OF status ON contracts WHEN NEW.status = 'active'
BEGIN
 INSERT OR IGNORE INTO delivery_workspaces(contract_id, task_version)
 SELECT NEW.id, task_version FROM bids WHERE id = NEW.bid_id;
END;
INSERT INTO delivery_workspaces(contract_id, task_version)
 SELECT c.id, b.task_version FROM contracts c JOIN bids b ON b.id = c.bid_id WHERE c.status = 'active';
CREATE TABLE delivery_permissions (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 actor_id TEXT NOT NULL,
 permission TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(contract_id, actor_id, permission)
);
CREATE TABLE delivery_requests (
 contract_id TEXT NOT NULL REFERENCES contracts(id),
 actor_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(contract_id, actor_id, request_key)
);
