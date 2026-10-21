import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../packages/database/src/index.js";

test("fresh migration matches schema, is repeatable and detects tampering", () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-db-"));
  const path = join(directory, "check.sqlite");
  const database = openDatabase(`file:${path}`);
  const inspection = new DatabaseSync(path);
  const expected = new DatabaseSync(":memory:");
  try {
    database.migrate();
    database.migrate();
    expected.exec(
      readFileSync("packages/database/schema/baseline.sql", "utf8")
    );
    const schema =
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name";
    assert.deepEqual(
      inspection.prepare(schema).all(),
      expected.prepare(schema).all()
    );
    assert.equal(
      inspection.prepare("SELECT count(*) AS count FROM _migrations").get()!
        .count,
      13
    );
    inspection.exec("UPDATE _migrations SET checksum = 'modified'");
    assert.throws(() => database.migrate(), /modified/);
    // A failed check must release its transaction.
    inspection.exec("BEGIN IMMEDIATE; ROLLBACK;");
  } finally {
    expected.close();
    inspection.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unsupported database providers fail without leaking connection data", () => {
  assert.throws(
    () => openDatabase("unsupported://example.invalid"),
    /^Error: DATABASE_URL must be a nonempty file: SQLite path$/
  );
});

test("identity credentials and revocation survive closing and reopening the database", async () => {
  const { Authorization, ForbiddenError } = await import(
    "../packages/auth/src/index.js"
  );
  const { seedIdentities } = await import("./fixtures/identity.js");
  const directory = mkdtempSync(join(tmpdir(), "octo-auth-"));
  const path = join(directory, "identity.sqlite");
  let database = openDatabase(`file:${path}`);
  try {
    database.migrate();
    const seed = new DatabaseSync(path);
    try {
      seed.exec("PRAGMA foreign_keys = ON");
      seedIdentities(seed);
    } finally {
      seed.close();
    }
    let auth = new Authorization(database.identities, () => 1000);
    const session = auth.issueUserSession("seller");
    const scope = {
      kind: "contract",
      resourceId: "contract-a",
      action: "read"
    } as const;
    const agent = database.agents(auth).create(session, {
      kind: "seller",
      capabilities: ["typescript"]
    });
    const issued = database.agents(auth).issue(session, agent.id, {
      scopes: [scope],
      ttlMs: 900000,
      confirmed: true
    });
    const token = issued.token;
    database.close();
    database = openDatabase(`file:${path}`);
    auth = new Authorization(database.identities, () => 1000);
    assert.equal(auth.authorize(token, scope).identity.kind, "agent");
    const listed = database.agents(auth).list(session);
    const persisted = listed.agents.find(value => value.id === agent.id)!;
    assert.deepEqual(persisted.capabilities, ["typescript"]);
    assert.deepEqual(persisted.credentials, [
      {
        id: issued.id,
        scopes: [scope],
        expiresAt: 901000,
        revoked: false
      }
    ]);
    assert.ok(!JSON.stringify(listed).includes(token));
    database.agents(auth).revoke(session, agent.id, issued.id);
    database.close();
    database = openDatabase(`file:${path}`);
    auth = new Authorization(database.identities, () => 1000);
    assert.throws(() => auth.authorize(token, scope), ForbiddenError);
    const listedAfterReopen = database.agents(auth).list(session);
    assert.equal(
      listedAfterReopen.agents.find(value => value.id === agent.id)!
        .credentials[0]!.revoked,
      true
    );
    assert.ok(!JSON.stringify(listedAfterReopen).includes(token));
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
