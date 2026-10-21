import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import {
  Authorization,
  bearerToken,
  csrfToken,
  tokenDigest
} from "../packages/auth/src/index.js";
import { LocalAccounts } from "../packages/database/src/accounts.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { Requirements } from "../packages/database/src/requirements.js";
import { Login } from "../apps/server/src/login.js";
import { handleRequest } from "../apps/server/src/app.js";
import { seedIdentities } from "./fixtures/identity.js";

async function fixture(production = false) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const accounts = new LocalAccounts(db);
  const password = randomBytes(24).toString("base64url");
  await accounts.create("local-buyer", "buyer", password);
  const login = new Login(accounts, auth, () => now, production);
  const requirements = new Requirements(db, auth, () => now);
  const call = (
    url: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
    raw?: string[]
  ) =>
    new Promise<{ status: number; headers: Record<string, string>; body: any }>(
      resolve => {
        const req = Readable.from(
          body === undefined ? [] : [JSON.stringify(body)]
        ) as IncomingMessage;
        req.url = url;
        req.method = method;
        req.headers = headers;
        req.rawHeaders = raw || Object.entries(headers).flat();
        Object.defineProperty(req, "socket", {
          value: { remoteAddress: "127.0.0.1" }
        });
        const output: Record<string, string> = {};
        const res = {
          statusCode: 200,
          setHeader(key: string, value: string) {
            output[key] = value;
          },
          end(value: string) {
            resolve({
              status: this.statusCode,
              headers: output,
              body: output["Content-Type"]?.includes("json")
                ? JSON.parse(value)
                : value
            });
          }
        };
        handleRequest(
          req,
          (res as unknown) as ServerResponse,
          auth,
          requirements,
          undefined,
          undefined,
          undefined,
          login
        );
      }
    );
  const signIn = (username = "local-buyer", secret = password) =>
    call(
      "/api/auth/login",
      "POST",
      { "content-type": "application/json", "x-octo-login": "1" },
      { username, password: secret }
    );
  return {
    db,
    auth,
    accounts,
    password,
    call,
    signIn,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

test("local password login, Cookie business access, CSRF, logout and safe persistence", async () => {
  const f = await fixture();
  try {
    const logged = await f.signIn();
    assert.equal(logged.status, 200);
    const cookie = logged.headers["Set-Cookie"]!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    assert.match(logged.headers["Set-Cookie"]!, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(logged.headers["Set-Cookie"]!, /Max-Age|Expires/);
    assert.ok(!JSON.stringify(logged.body).includes(token));
    assert.equal((await f.call("/console", "GET", { cookie })).status, 200);
    const me = await f.call("/api/auth/me", "GET", { cookie });
    assert.equal(me.body.data.identity.id, "buyer");
    assert.equal(me.body.data.csrf, csrfToken(token));
    const headers = { cookie, "content-type": "application/json" };
    const draft = {
      projectId: "project-a",
      draft: { values: {}, publicFields: [] }
    };
    assert.equal(
      (await f.call("/api/requirements", "POST", headers, draft)).status,
      403
    );
    assert.equal(
      (
        await f.call(
          "/api/requirements",
          "POST",
          {
            ...headers,
            "x-csrf-token": csrfToken(randomBytes(32).toString("base64url"))
          },
          draft
        )
      ).status,
      403
    );
    const created = await f.call(
      "/api/requirements",
      "POST",
      { ...headers, "x-csrf-token": me.body.data.csrf },
      draft
    );
    assert.equal(created.status, 200);
    const path = "/api/requirements/" + created.body.data.id;
    assert.equal((await f.call(path, "GET", { cookie })).status, 200);
    assert.notEqual(
      (await f.call("/api/auth/logout", "POST", { cookie })).status,
      200
    );
    const logout = await f.call("/api/auth/logout", "POST", {
      cookie,
      "x-csrf-token": me.body.data.csrf
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers["Set-Cookie"]!, /Max-Age=0/);
    assert.equal((await f.call(path, "GET", { cookie })).status, 403);
    assert.equal((await f.call("/api/auth/me", "GET", { cookie })).status, 401);
    for (const table of [
      "users",
      "local_accounts",
      "credentials",
      "audit_events",
      "requirements"
    ]) {
      const stored = JSON.stringify(
        f.db.prepare(`SELECT * FROM ${table}`).all()
      );
      assert.ok(!stored.includes(f.password));
      assert.ok(!stored.includes(token));
    }
  } finally {
    f.db.close();
  }
});

test("identical credential errors, bounded login rate and recovery", async () => {
  const f = await fixture();
  try {
    const missing = await f.signIn("absent");
    const wrong = await f.signIn(
      "local-buyer",
      randomBytes(24).toString("hex")
    );
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(missing.body.error, wrong.body.error);
    for (let i = 0; i < 3; i++) await f.signIn("absent");
    assert.equal((await f.signIn()).status, 429);
    f.advance(60000);
    assert.equal((await f.signIn()).status, 200);
  } finally {
    f.db.close();
  }
});

test("expiry, revocation, Secure cookies and ambiguous authentication", async () => {
  const f = await fixture(true);
  try {
    const logged = await f.signIn();
    assert.match(logged.headers["Set-Cookie"]!, /; Secure$/);
    const cookie = logged.headers["Set-Cookie"]!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    const path = "/api/access/project/project-a";
    assert.equal((await f.call(path, "GET", { cookie })).status, 200);
    assert.equal(
      (await f.call(path, "GET", { cookie, authorization: "Bearer " + token }))
        .status,
      403
    );
    assert.equal(
      (await f.call(path, "GET", { cookie: cookie + "; " + cookie })).status,
      403
    );
    assert.equal(
      (
        await f.call(path, "GET", {}, undefined, [
          "Cookie",
          cookie,
          "Cookie",
          cookie
        ])
      ).status,
      403
    );
    assert.throws(() =>
      bearerToken({
        rawHeaders: ["Authorization", "Bearer " + token, "Cookie", cookie]
      } as IncomingMessage)
    );
    f.auth.revoke(token, tokenDigest(token));
    assert.equal((await f.call(path, "GET", { cookie })).status, 403);
    const second = await f.signIn();
    const nextCookie = second.headers["Set-Cookie"]!.split(";")[0]!;
    f.advance(3600000);
    assert.equal(
      (await f.call(path, "GET", { cookie: nextCookie })).status,
      403
    );
    assert.equal(
      (await f.call("/api/auth/me", "GET", { cookie: nextCookie })).status,
      401
    );
    assert.equal(
      (
        await f.call(
          "/api/auth/login",
          "POST",
          { "content-type": "application/json" },
          { username: "local-buyer", password: f.password }
        )
      ).status,
      403
    );
    const agent = f.auth.issueAgentToken(
      f.auth.issueUserSession("seller"),
      "agent-a",
      []
    );
    assert.equal(
      (await f.call(path, "GET", { cookie: "octo_session=" + agent })).status,
      403
    );
  } finally {
    f.db.close();
  }
});

test("offline provisioning salts each password and rolls back duplicate accounts", async () => {
  const f = await fixture();
  try {
    await f.accounts.create("local-seller", "seller", f.password);
    const rows = f.db
      .prepare("SELECT salt, password_hash FROM local_accounts")
      .all();
    assert.notEqual(rows[0]!.salt, rows[1]!.salt);
    assert.notEqual(rows[0]!.password_hash, rows[1]!.password_hash);
    await assert.rejects(
      f.accounts.create("local-buyer", "new-user", f.password)
    );
    assert.equal(
      f.db.prepare("SELECT id FROM users WHERE id = 'new-user'").get(),
      undefined
    );
  } finally {
    f.db.close();
  }
});

test("offline command reads passwords from stdin and grants no business permissions", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { openDatabase } = await import("../packages/database/src/index.js");
  const dir = mkdtempSync(join(tmpdir(), "octo-account-"));
  const path = join(dir, "accounts.sqlite");
  const db = openDatabase("file:" + path);
  const password = randomBytes(24).toString("base64url");
  try {
    db.migrate();
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "dist/packages/database/src/create-account.js",
          "synthetic-account",
          "synthetic-user"
        ],
        {
          env: { ...process.env, DATABASE_URL: "file:" + path },
          input: password + "\n",
          encoding: "utf8"
        }
      );
    const first = run();
    assert.equal(first.status, 0);
    assert.ok(!(first.stdout + first.stderr).includes(password));
    assert.equal(
      await db.accounts.verify("synthetic-account", password),
      "synthetic-user"
    );
    const duplicate = run();
    assert.equal(duplicate.status, 1);
    assert.ok(!(duplicate.stdout + duplicate.stderr).includes(password));
    const inspection = new DatabaseSync(path);
    try {
      assert.equal(
        inspection.prepare("SELECT count(*) n FROM memberships").get()!.n,
        0
      );
      assert.equal(
        inspection.prepare("SELECT count(*) n FROM resource_grants").get()!.n,
        0
      );
    } finally {
      inspection.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
