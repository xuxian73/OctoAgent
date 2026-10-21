CREATE TABLE mcp_requests (
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(actor_id, request_id)
);
CREATE TRIGGER mcp_requests_no_update BEFORE UPDATE ON mcp_requests
BEGIN SELECT RAISE(ABORT, 'immutable MCP request'); END;
CREATE TRIGGER mcp_requests_no_delete BEFORE DELETE ON mcp_requests
BEGIN SELECT RAISE(ABORT, 'immutable MCP request'); END;
