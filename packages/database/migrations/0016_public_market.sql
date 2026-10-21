-- Only explicitly published fields enter discovery; drafts and attachments never do.
CREATE VIEW market_publications AS
SELECT r.id, r.project_id, r.version,
 json_extract(r.published, '$.market') AS market,
 (SELECT json_group_object(f.value, json_extract(r.published, '$.values.' || f.value))
  FROM json_each(r.published, '$.publicFields') f) AS public_values
FROM requirements r
WHERE r.version > 0 AND json_type(r.published, '$.market') = 'object';

CREATE TABLE market_participations (
 requirement_id TEXT NOT NULL REFERENCES requirements(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
 PRIMARY KEY (requirement_id, user_id)
);
