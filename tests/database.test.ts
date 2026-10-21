import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    const appliedMigrations = inspection
      .prepare("SELECT name FROM _migrations ORDER BY name")
      .all()
      .map(row => row.name);
    // Preserve both disputes and notification-read migrations.
    assert.ok(appliedMigrations.includes("0013_disputes.sql"));
    assert.ok(appliedMigrations.includes("0014_notification_reads.sql"));
    assert.deepEqual(
      appliedMigrations,
      readdirSync("packages/database/migrations")
        .filter(name => name.endsWith(".sql"))
        .sort()
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

test("main database upgrades preserve notifications and durable idempotent reads", async () => {
  const { Authorization } = await import("../packages/auth/src/index.js");
  const { seedIdentities } = await import("./fixtures/identity.js");
  const directory = mkdtempSync(join(tmpdir(), "octo-notifications-"));
  const path = join(directory, "upgrade.sqlite");
  let database = openDatabase(`file:${path}`);
  try {
    database.migrate();
    const seed = new DatabaseSync(path);
    try {
      seed.exec("PRAGMA foreign_keys = ON");
      // Reproduce main's schema and migration ledger before notification reads.
      seed.exec(`DROP VIEW market_publications;
        DROP TABLE market_participations;
        DELETE FROM _migrations WHERE name = '0016_public_market.sql';
        DROP TABLE seller_profiles;
        DELETE FROM _migrations WHERE name = '0015_seller_profiles.sql';
        DROP TABLE requirement_notification_reads;
        DELETE FROM _migrations WHERE name = '0014_notification_reads.sql';`);
      assert.equal(
        seed.prepare("SELECT count(*) AS n FROM _migrations").get()!.n,
        13
      );
      assert.ok(
        seed
          .prepare("SELECT 1 FROM _migrations WHERE name = '0013_disputes.sql'")
          .get()
      );
      seedIdentities(seed);
      seed.exec(`INSERT INTO requirements VALUES
        ('task', 'project-a', 2, 2, '{}', '{"market":{"allowAgents":true}}', '[]');
        INSERT INTO requirement_changes VALUES ('task', 2, 'buyer', '[]');
        INSERT INTO requirement_notifications VALUES
        ('task', 2, 'seller', 'requirement_changed');`);
    } finally {
      seed.close();
    }
    database.migrate();
    let auth = new Authorization(database.identities, () => 1000);
    const token = auth.issueUserSession("seller");
    let market = database.market(auth);
    assert.equal(market.notifications(token).items[0]!.readAt, null);
    const marked = market.readNotification(token, "task", 2);
    database.close();
    database = openDatabase(`file:${path}`);
    database.migrate();
    auth = new Authorization(database.identities, () => 1000);
    market = database.market(auth);
    assert.equal(market.notifications(token).items[0]!.readAt, marked.readAt);
    assert.deepEqual(market.readNotification(token, "task", 2), marked);
    const inspection = new DatabaseSync(path);
    try {
      assert.equal(
        inspection
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE event = 'Market.readNotification'"
          )
          .get()!.n,
        1
      );
      assert.equal(
        inspection.prepare("SELECT count(*) AS n FROM _migrations").get()!.n,
        16
      );
    } finally {
      inspection.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
