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
      1
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
