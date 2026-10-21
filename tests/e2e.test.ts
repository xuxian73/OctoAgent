import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDemo } from "../packages/demo/src/index.js";

test("offline pages + HTTP + MCP: publish, compare, contract, evidence, rework, accept and dispute freeze; seed is repeatable", async t => {
  const directory = mkdtempSync(join(tmpdir(), "octo-e2e-"));
  try {
    const report = await initializeDemo(directory);
    assert.deepEqual(report.outcomes, ["completed", "disputed"]);
    for (const error of [
      "FORBIDDEN",
      "CONFIRMATION_EXPIRED",
      "STALE_CONFIRMATION",
      "CONFIRMATION_REQUIRED",
      "DISPUTE_FROZEN",
      "EVIDENCE_INCOMPLETE"
    ])
      assert.ok(
        report.steps.some(step => step.result === error),
        error
      );
    assert.ok(report.steps.every(step => step.audit.length > 0));
    assert.ok(
      report.steps
        .filter(step => step.result === "FORBIDDEN")
        .every(step => step.audit.some(event => event.result === "rejected"))
    );
    const db = new DatabaseSync(join(directory, "demo.sqlite"));
    const snapshot = () =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all()
        .map(row => [
          row.name,
          db
            .prepare(`SELECT * FROM "${String(row.name).replace(/"/g, '""')}"`)
            .all()
        ]);
    try {
      const before = snapshot();
      const evidence = readFileSync(
        join(directory, "repositories.json"),
        "utf8"
      );
      assert.deepEqual(await initializeDemo(directory), report);
      assert.deepEqual(snapshot(), before);
      assert.equal(
        readFileSync(join(directory, "repositories.json"), "utf8"),
        evidence
      );
      assert.equal(db.prepare("SELECT count(*) n FROM contracts").get()!.n, 2);
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM credentials WHERE revoked = 0")
          .get()!.n,
        0
      );
      for (const repository of JSON.parse(evidence)) {
        assert.equal(repository.provider, "offline-fake");
        assert.equal(repository.deployments.length, 0);
        assert.ok(repository.commits.length > 0);
        assert.ok(repository.submissions.length > 0);
      }
      // Test output provides safe traceable evidence, not raw API payloads.
      for (const step of report.steps.filter(s =>
        [
          "human_confirmation_required",
          "FORBIDDEN",
          "CONFIRMATION_EXPIRED",
          "DISPUTE_FROZEN"
        ].includes(s.result)
      ))
        t.diagnostic(JSON.stringify(step));
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed seed rolls back and retries; refuses a non-demo database", async () => {
  const { openDatabase } = await import("../packages/database/src/index.js");
  const directory = mkdtempSync(join(tmpdir(), "octo-seed-rollback-"));
  const path = join(directory, "demo.sqlite");
  const database = openDatabase("file:" + path);
  database.migrate();
  database.close();
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER fail_seed BEFORE INSERT ON contracts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
    );
    await assert.rejects(initializeDemo(directory));
    for (const table of [
      "users",
      "requirements",
      "audit_events",
      "platform_metadata"
    ])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
    db.exec(
      "DROP TRIGGER fail_seed; INSERT INTO users VALUES ('existing-local-user', 'member')"
    );
    await assert.rejects(initializeDemo(directory), /DEMO_DATABASE_NOT_EMPTY/);
    assert.equal(db.prepare("SELECT count(*) n FROM users").get()!.n, 1);
    db.exec("DELETE FROM users");
    assert.deepEqual((await initializeDemo(directory)).outcomes, [
      "completed",
      "disputed"
    ]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace page loads seeded API evidence and clears it on tenant switch", async t => {
  const { Authorization } = await import("../packages/auth/src/index.js");
  const { SqliteIdentityStore } = await import(
    "../packages/database/src/identity.js"
  );
  const { Requirements } = await import(
    "../packages/database/src/requirements.js"
  );
  const { Market } = await import("../packages/database/src/market.js");
  const { Contracts } = await import("../packages/database/src/contracts.js");
  const { Workspaces } = await import("../packages/database/src/workspaces.js");
  const { McpRequests } = await import("../packages/database/src/mcp.js");
  const { localRequest } = await import("../packages/demo/src/transport.js");
  const { mountWorkspaces } = await import("../apps/web/src/workspaces.js");
  const directory = mkdtempSync(join(tmpdir(), "octo-page-e2e-"));
  try {
    const report = await initializeDemo(directory);
    const db = new DatabaseSync(join(directory, "demo.sqlite"));
    try {
      const auth = new Authorization(new SqliteIdentityStore(db));
      const services = {
        auth,
        requirements: new Requirements(db, auth),
        market: new Market(db, auth),
        contracts: new Contracts(db, auth),
        workspaces: new Workspaces(db, auth),
        requests: new McpRequests(db)
      };
      // Minimal DOM surface: real page event handler, fetch adapter and API service.
      let finished: () => void = () => {};
      class Element extends EventTarget {
        value = "";
        private content = "";
        get textContent() {
          return this.content;
        }
        set textContent(value: string) {
          this.content = value;
          if (this === elements.status && value) finished();
        }
      }
      const elements: Record<string, Element> = Object.fromEntries(
        [
          "session",
          "contract",
          "load",
          "status",
          "commits",
          "checks",
          "pullRequests",
          "artifacts",
          "submissions",
          "risks",
          "deployments",
          "context"
        ].map(id => [id, new Element()])
      );
      t.mock.method(
        globalThis,
        "fetch",
        async (url: string, init: RequestInit) => {
          const token = (init.headers as Record<
            string,
            string
          >).Authorization!.slice(7);
          const result = await localRequest(services, token, url);
          return { json: async () => JSON.parse(result.text) };
        }
      );
      mountWorkspaces(({
        getElementById: (id: string) => elements[id]
      } as unknown) as Document);
      elements.session!.value = auth.issueUserSession("demo-buyer");
      elements.contract!.value = report.contracts[0]!;
      const load = () =>
        new Promise<void>(resolve => {
          finished = resolve;
          elements.load!.dispatchEvent(new Event("click"));
        });
      await load();
      assert.match(elements.status!.textContent, /completed/);
      assert.equal(JSON.parse(elements.submissions!.textContent).length, 2);
      assert.equal(JSON.parse(elements.artifacts!.textContent).length, 2);
      assert.ok(
        JSON.parse(elements.context!.textContent).auditEventReferences.length >
          0
      );
      elements.session!.value = auth.issueUserSession("other-buyer");
      elements.session!.dispatchEvent(new Event("input"));
      assert.equal(elements.commits!.textContent, "");
      assert.equal(elements.artifacts!.textContent, "");
      await load();
      assert.match(elements.status!.textContent, /读取失败/);
      assert.equal(elements.submissions!.textContent, "");
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
