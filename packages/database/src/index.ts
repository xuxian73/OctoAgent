import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { Requirements } from "./requirements.js";
import { Authorization } from "../../auth/src/index.js";
import { SqliteIdentityStore } from "./identity.js";
import { IdentityStore } from "../../auth/src/model.js";

// Services depend on this interface, not a driver or SQL dialect.
export interface Database {
  readonly identities: IdentityStore;
  requirements(auth: Authorization): Requirements;
  migrate(): void;
  close(): void;
}
export const migrationsDirectory = resolve("packages/database/migrations");

export function openDatabase(url: string): Database {
  if (!url.startsWith("file:") || url.length === 5) {
    throw new Error("DATABASE_URL must be a nonempty file: SQLite path");
  }
  const path = resolve(url.slice(5));
  mkdirSync(dirname(path), { recursive: true });
  const connection = new DatabaseSync(path);
  connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    identities: new SqliteIdentityStore(connection),
    requirements: auth => new Requirements(connection, auth),
    migrate() {
      connection.exec("BEGIN IMMEDIATE");
      try {
        connection.exec(
          "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)"
        );
        const files = readdirSync(migrationsDirectory)
          .filter(name => name.endsWith(".sql"))
          .sort();
        const applied = connection
          .prepare("SELECT name, checksum FROM _migrations")
          .all();
        for (const row of applied) {
          if (!files.includes(String(row.name)))
            throw new Error("Applied migration is missing");
        }
        for (const name of files) {
          const sql = readFileSync(resolve(migrationsDirectory, name), "utf8");
          const checksum = createHash("sha256")
            .update(sql)
            .digest("hex");
          const previous = applied.find(row => row.name === name);
          if (previous) {
            if (previous.checksum !== checksum)
              throw new Error("Applied migration was modified");
            continue;
          }
          connection.exec(sql);
          connection
            .prepare("INSERT INTO _migrations (name, checksum) VALUES (?, ?)")
            .run(name, checksum);
        }
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      connection.close();
    }
  };
}
