import { DatabaseSync } from "node:sqlite";

// Synthetic, reusable subjects. Credentials are generated at runtime, never seeded.
export function seedIdentities(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO users VALUES ('buyer', 'member'), ('seller', 'member'), ('admin', 'admin'), ('outsider', 'member');
    INSERT INTO organizations VALUES ('org-a'), ('org-b');
    INSERT INTO projects VALUES ('project-a', 'org-a'), ('project-b', 'org-b');
    INSERT INTO memberships VALUES
      ('buyer', 'org-a', '', 'buyer'), ('buyer', 'org-a', 'project-a', 'buyer'),
      ('seller', 'org-a', '', 'seller'), ('seller', 'org-a', 'project-a', 'seller'),
      ('admin', 'org-a', '', 'admin'), ('admin', 'org-a', 'project-a', 'admin'),
      ('outsider', 'org-b', '', 'buyer'), ('outsider', 'org-b', 'project-b', 'buyer');
    INSERT INTO agents VALUES ('agent-a', 'seller', 'seller', '["typescript","testing"]');
    INSERT INTO authorization_resources VALUES
      ('organization', 'org-a', 'org-a', NULL),
      ('organization', 'org-b', 'org-b', NULL),
      ('project', 'project-a', 'org-a', 'project-a'),
      ('project', 'project-b', 'org-b', 'project-b'),
      ('contract', 'contract-a', 'org-a', 'project-a'),
      ('contract', 'contract-other', 'org-a', 'project-a'),
      ('contract', 'contract-b', 'org-b', 'project-b'),
      ('workspace', 'workspace-a', 'org-a', 'project-a'),
      ('repository', 'private-a', 'org-a', 'project-a'),
      ('secret', 'secret-a', 'org-a', 'project-a'),
      ('production', 'production-a', 'org-a', 'project-a');
  `);
  const grant = db.prepare("INSERT INTO resource_grants VALUES (?, ?, ?, ?)");
  for (const user of ["buyer", "seller"]) {
    for (const [kind, id] of [
      ["organization", "org-a"],
      ["project", "project-a"],
      ["contract", "contract-a"],
      ["workspace", "workspace-a"]
    ]) {
      for (const action of ["read", "write", "delegate"])
        grant.run(user!, kind!, id!, action);
    }
  }
  grant.run("outsider", "contract", "contract-b", "read");
}
