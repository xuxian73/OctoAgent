import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../database/src/index.js";
import { Report, runScenario } from "./scenario.js";

// Dedicated demo database, never reads DATABASE_URL or an application's .env.
// The completion marker and all scenario writes commit together. A failed run
// rolls back and can be retried; a completed run never creates new resources.
export async function initializeDemo(directory: string): Promise<Report> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "demo.sqlite");
  const database = openDatabase("file:" + path);
  try {
    database.migrate();
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  try {
    db.exec("BEGIN IMMEDIATE");
    let report: Report;
    try {
      const previous = db
        .prepare(
          "SELECT value FROM platform_metadata WHERE key='offline-demo-v1'"
        )
        .get();
      if (previous) report = JSON.parse(String(previous.value)) as Report;
      else {
        if (db.prepare("SELECT count(*) n FROM users").get()!.n !== 0)
          throw new Error("DEMO_DATABASE_NOT_EMPTY");
        report = await runScenario(db);
        db.prepare(
          "INSERT INTO platform_metadata VALUES ('offline-demo-v1', ?)"
        ).run(JSON.stringify(report));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const repositories = db
      .prepare(
        "SELECT contract_id,state FROM delivery_workspaces ORDER BY contract_id"
      )
      .all()
      .map(row => ({
        contract_id: row.contract_id,
        provider: "offline-fake",
        zipDeliveries: db
          .prepare("SELECT * FROM zip_deliveries WHERE contract_id=?")
          .all(row.contract_id!),
        ...JSON.parse(String(row.state))
      }));
    // These exports contain only synthetic evidence, never sessions or handoff credentials.
    writeFileSync(
      join(root, "repositories.json"),
      JSON.stringify(repositories, null, 2) + "\n",
      { mode: 0o600 }
    );
    writeFileSync(
      join(root, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 }
    );
    return report;
  } finally {
    db.close();
  }
}
