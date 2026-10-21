-- Password material is isolated from business records; sessions remain digest-only.
CREATE TABLE local_accounts (
  username TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
