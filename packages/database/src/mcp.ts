import { DatabaseSync } from "node:sqlite";
import { RequirementError } from "../../requirements/src/model.js";
// Business-service boundary: atomically records the result with the mutation.
// Callers must reauthorize before every run, including replay.
export class McpRequests {
  constructor(private db: DatabaseSync) {}
  run<T>(
    actor: string,
    key: string,
    fingerprint: string,
    authorize: () => void,
    execute: () => T
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      authorize();
      const prior = this.db
        .prepare(
          "SELECT fingerprint, result FROM mcp_requests WHERE actor_id = ? AND request_id = ?"
        )
        .get(actor, key);
      if (prior && prior.fingerprint !== fingerprint)
        throw new RequirementError("REQUEST_KEY_REUSED", 409);
      const result = prior
        ? (JSON.parse(String(prior.result)) as T)
        : execute();
      if (!prior)
        this.db
          .prepare("INSERT INTO mcp_requests VALUES (?, ?, ?, ?)")
          .run(actor, key, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
