import { DatabaseSync } from "node:sqlite";
import { Authorization } from "../../auth/src/index.js";
import { SqliteIdentityStore } from "../../database/src/identity.js";
import { Checks } from "../../database/src/checks.js";
import { ContainerExecutor, executorConfig } from "./executor.js";
const url = process.env.DATABASE_URL || "file:./.data/octoagent.sqlite";
if (!url.startsWith("file:")) throw new Error("SQLite configuration required");
const db = new DatabaseSync(url.slice(5));
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
const service = new Checks(db, new Authorization(new SqliteIdentityStore(db)));
let config = null;
try {
  config = executorConfig();
} catch {
  /* All requests become unavailable. */
}
const executor = new ContainerExecutor(config);
// This executable is deployed separately; the Web process never launches it.
try {
  do {
    const worked = await service.work(executor);
    if (process.argv.includes("--once")) break;
    if (!worked) await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
} finally {
  db.close();
}
