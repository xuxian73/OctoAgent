import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Authorization, tokenDigest } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import { RepositoryState } from "../../delivery/src/github.js";
import { LocalGitProvider } from "../../delivery/src/local-git.js";
import { ContainerExecutor, CheckResult } from "../../delivery/src/executor.js";

export class Checks {
  constructor(
    private db: DatabaseSync,
    private auth: Authorization,
    private git = new LocalGitProvider(),
    private now = Date.now
  ) {}
  list(id: string): CheckResult[] {
    return this.db
      .prepare(
        "SELECT result FROM isolated_checks WHERE contract_id=? ORDER BY rowid"
      )
      .all(id)
      .map(r => JSON.parse(String(r.result)));
  }
  enqueue(
    token: string,
    id: string,
    state: RepositoryState,
    version: number,
    sha: string,
    kind: string
  ) {
    if (
      !["test", "typecheck"].includes(kind) ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !state.commits.some(c => c.sha === sha && c.version === version)
    )
      throw new RequirementError("INVALID_CHECK");
    this.git.verify(state, id);
    const identity = this.auth.identity(token);
    const existing = this.db
      .prepare(
        "SELECT result FROM isolated_checks WHERE contract_id=? AND sha=? AND kind=? AND version=? AND status IN ('queued','running')"
      )
      .get(id, sha, kind, version);
    if (existing) return JSON.parse(String(existing.result));
    const result: CheckResult = {
      id: randomUUID(),
      sha,
      kind,
      version,
      status: "queued",
      passed: false,
      simulated: false,
      exitCode: null,
      startedAt: null,
      endedAt: null,
      image: "",
      executor: "pending",
      command: [],
      log: "",
      truncated: false
    };
    this.db
      .prepare(
        "INSERT INTO isolated_checks(id,contract_id,credential_digest,actor_id,version,sha,kind,snapshot,status,result) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        result.id,
        id,
        tokenDigest(token),
        identity.id,
        version,
        sha,
        kind,
        JSON.stringify(state),
        result.status,
        JSON.stringify(result)
      );
    return result;
  }
  cancel(id: string, checkId: string) {
    const row = this.db
      .prepare(
        "SELECT result FROM isolated_checks WHERE id=? AND contract_id=?"
      )
      .get(checkId, id);
    if (!row) throw new RequirementError("INVALID_CHECK");
    const result: CheckResult = JSON.parse(String(row.result));
    if (["queued", "running"].includes(result.status)) {
      result.status = "cancelled";
      result.passed = false;
      result.endedAt = this.now();
      this.save(result);
    }
    return result;
  }
  private save(result: CheckResult) {
    this.db
      .prepare("UPDATE isolated_checks SET status=?,result=? WHERE id=?")
      .run(result.status, JSON.stringify(result), result.id);
    const row = this.db
      .prepare("SELECT contract_id FROM isolated_checks WHERE id=?")
      .get(result.id);
    if (row)
      this.db
        .prepare(
          "INSERT INTO contract_events(contract_id,version,actor_id,created_at,kind,payload) VALUES (?,?,?,?,?,?)"
        )
        .run(
          String(row.contract_id),
          result.version,
          "system:check-worker",
          this.now(),
          "workspace_check_status",
          JSON.stringify({
            id: result.id,
            sha: result.sha,
            status: result.status
          })
        );
  }
  private authorized(row: Record<string, unknown>) {
    try {
      const id = String(row.contract_id);
      this.auth.authorizeStoredCredential(
        String(row.credential_digest),
        { kind: "contract", resourceId: id, action: "read" },
        ["seller"]
      );
      this.auth.authorizeStoredCredential(
        String(row.credential_digest),
        { kind: "contract", resourceId: id, action: "write" },
        ["seller"]
      );
      const contract = this.db
        .prepare("SELECT status,version FROM contracts WHERE id=?")
        .get(id);
      return (
        contract?.status === "active" &&
        contract.version === row.version &&
        !!this.db
          .prepare(
            "SELECT 1 FROM delivery_permissions WHERE contract_id=? AND actor_id=? AND permission='check' AND expires_at>?"
          )
          .get(id, String(row.actor_id), this.now())
      );
    } catch {
      return false;
    }
  }
  /** One durable claim at a time; no transaction is held during execution. */
  async work(executor: ContainerExecutor) {
    // Crash recovery: never rerun an abandoned attempt or publish its old success.
    for (const stale of this.db
      .prepare(
        "SELECT result FROM isolated_checks WHERE status<>'queued' AND lease_until>0 AND lease_until<?"
      )
      .all(this.now())) {
      const result: CheckResult = JSON.parse(String(stale.result));
      if (!executor.cleanup(result.id)) {
        result.status =
          result.status === "running" ? "unavailable" : result.status;
        result.passed = false;
        result.cleanupPending = true;
        result.endedAt = this.now();
        this.save(result);
        continue;
      }
      result.status =
        result.status === "running" ? "unavailable" : result.status;
      result.cleanupPending = false;
      result.passed = false;
      result.endedAt = this.now();
      this.save(result);
      this.db
        .prepare("UPDATE isolated_checks SET lease_until=0 WHERE id=?")
        .run(result.id);
    }
    this.db.exec("BEGIN IMMEDIATE");
    let row;
    try {
      row = this.db
        .prepare(
          "SELECT * FROM isolated_checks WHERE status='queued' ORDER BY rowid LIMIT 1"
        )
        .get();
      if (row) {
        const result: CheckResult = JSON.parse(String(row.result));
        result.status = "running";
        result.startedAt = this.now();
        row.result = JSON.stringify(result);
        this.save(result);
        this.db
          .prepare("UPDATE isolated_checks SET lease_until=? WHERE id=?")
          .run(this.now() + 360000, result.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!row) return false;
    const base: CheckResult = JSON.parse(String(row.result));
    const abort = new AbortController();
    const valid = () =>
      this.authorized(row!) &&
      this.db
        .prepare("SELECT status FROM isolated_checks WHERE id=?")
        .get(base.id)?.status === "running";
    const monitor = setInterval(() => {
      if (!valid()) abort.abort();
    }, 100);
    let result: CheckResult;
    try {
      if (!valid()) abort.abort();
      result = abort.signal.aborted
        ? { ...base, status: "cancelled", endedAt: this.now() }
        : await executor.run(
            base,
            this.git.snapshot(
              JSON.parse(String(row.snapshot)),
              String(row.contract_id),
              base.sha
            ),
            abort.signal
          );
    } catch {
      result = { ...base, status: "unavailable", endedAt: this.now() };
    } finally {
      clearInterval(monitor);
    }
    if (!valid()) {
      result.status = "cancelled";
      result.passed = false;
    }
    this.save(result);
    this.db
      .prepare("UPDATE isolated_checks SET lease_until=? WHERE id=?")
      .run(result.cleanupPending ? this.now() + 30000 : 0, result.id);
    return true;
  }
}
