CREATE TABLE seller_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  task_types TEXT NOT NULL,
  bio TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status = 'completed')
);
