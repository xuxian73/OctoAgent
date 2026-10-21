import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import {
  Authorization,
  AuditRecord,
  ForbiddenError,
  MAX_AGENT_TTL_MS,
  Scope,
  tokenDigest
} from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { seedIdentities } from "./fixtures/identity.js";
import { handleRequest } from "../apps/server/src/app.js";

const read: Scope = {
  kind: "contract",
  resourceId: "contract-a",
  action: "read"
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  let now = 1000000;
  const events: AuditRecord[] = [];
  const store = new SqliteIdentityStore(db);
  const auth = new Authorization(
    store,
    () => now,
    event => events.push(event)
  );
  const buyer = auth.issueUserSession("buyer");
  const seller = auth.issueUserSession("seller");
  const admin = auth.issueUserSession("admin");
  const agent = auth.issueAgentToken(seller, "agent-a", [read], 1000);
  return {
    db,
    auth,
    store,
    buyer,
    seller,
    admin,
    agent,
    events,
    advance: (ms: number) => {
      now += ms;
    }
  };
}
function http(
  auth: Authorization,
  token: string | null,
  path = "/api/access/contract/contract-a",
  extra: string[] = []
) {
  let body = "";
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    end: (value: string) => {
      body = value;
    }
  };
  handleRequest(
    {
      method: "GET",
      url: path,
      rawHeaders: [
        ...(token ? ["Authorization", "Bearer " + token] : []),
        ...extra
      ]
    } as IncomingMessage,
    (response as unknown) as ServerResponse,
    auth
  );
  return { status: response.statusCode, body: JSON.parse(body), headers };
}

test("role matrix, exact resource grants and current tenant membership are enforced", () => {
  const f = fixture();
  try {
    for (const [token, role] of [
      [f.buyer, "buyer"],
      [f.seller, "seller"]
    ] as const) {
      assert.equal(f.auth.authorize(token, read).role, role);
      assert.equal(
        f.auth.authorize(token, { ...read, action: "write" }).identity.kind,
        "user"
      );
      assert.throws(
        () => f.auth.authorize(token, read, ["admin"]),
        ForbiddenError
      );
      for (const resourceId of ["contract-b", "contract-other", "missing"]) {
        assert.throws(
          () => f.auth.authorize(token, { ...read, resourceId }),
          ForbiddenError
        );
      }
    }
    assert.throws(() => f.auth.authorize(f.admin, read), ForbiddenError);
    f.db
      .prepare(
        "INSERT INTO resource_grants VALUES ('admin', 'contract', 'contract-a', 'read')"
      )
      .run();
    assert.equal(f.auth.authorize(f.admin, read).role, "admin");
    assert.throws(
      () => f.auth.authorize(f.admin, { ...read, action: "write" }),
      ForbiddenError
    );
    f.db.exec(
      "DELETE FROM memberships WHERE user_id = 'seller' AND project_id = 'project-a'"
    );
    assert.throws(() => f.auth.authorize(f.agent, read), ForbiddenError);
  } finally {
    f.db.close();
  }
});

test("agent credentials are bounded, exact-scoped and never grant ambient sensitive access", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.auth.authorize(f.agent, read).identity, {
      kind: "agent",
      id: "agent-a",
      responsibleUserId: "seller"
    });
    for (const scope of [
      { ...read, action: "write" },
      { ...read, action: "delegate" },
      { ...read, resourceId: "contract-other" },
      { ...read, resourceId: "contract-b" },
      { kind: "repository", resourceId: "private-a", action: "read" },
      { kind: "secret", resourceId: "secret-a", action: "read" },
      { kind: "production", resourceId: "production-a", action: "read" }
    ] as Scope[])
      assert.throws(() => f.auth.authorize(f.agent, scope), ForbiddenError);
    const empty = f.auth.issueAgentToken(f.seller, "agent-a");
    assert.throws(() => f.auth.authorize(empty, read), ForbiddenError);
    for (const ttl of [0, -1, NaN, Infinity, 0.5, MAX_AGENT_TTL_MS + 1]) {
      assert.throws(
        () => f.auth.issueAgentToken(f.seller, "agent-a", [read], ttl),
        ForbiddenError
      );
    }
    assert.throws(
      () => f.auth.issueAgentToken(f.buyer, "agent-a", [read]),
      ForbiddenError
    );
    assert.throws(
      () => f.auth.issueAgentToken(f.agent, "agent-a", [read]),
      ForbiddenError
    );
    assert.throws(
      () =>
        f.auth.issueAgentToken(f.seller, "agent-a", [
          { ...read, resourceId: "contract-b" }
        ]),
      ForbiddenError
    );
    f.db.exec("DELETE FROM resource_grants WHERE action = 'delegate'");
    assert.throws(
      () => f.auth.issueAgentToken(f.seller, "agent-a", [read]),
      ForbiddenError
    );
    assert.throws(
      () =>
        f.auth.authorize(f.agent, ({
          ...read,
          action: "toString"
        } as unknown) as Scope),
      ForbiddenError
    );
  } finally {
    f.db.close();
  }
});

test("expiry at boundary, durable revocation, responsibility and grant removal fail closed", () => {
  const f = fixture();
  try {
    f.advance(1000);
    assert.throws(() => f.auth.authorize(f.agent, read), ForbiddenError);
    const token = f.auth.issueAgentToken(f.seller, "agent-a", [read]);
    assert.throws(
      () => f.auth.revoke(f.buyer, tokenDigest(token)),
      ForbiddenError
    );
    f.auth.revoke(f.admin, tokenDigest(token));
    const freshService = new Authorization(
      new SqliteIdentityStore(f.db),
      () => 1001000
    );
    assert.throws(() => freshService.authorize(token, read), ForbiddenError);
    const live = f.auth.issueAgentToken(f.seller, "agent-a", [read]);
    f.db.exec(
      "DELETE FROM resource_grants WHERE user_id = 'seller' AND action = 'read'"
    );
    assert.throws(() => f.auth.authorize(live, read), ForbiddenError);
    assert.throws(() =>
      f.db.exec("INSERT INTO agents VALUES ('orphan', NULL, 'seller', '[]')")
    );
    assert.throws(() =>
      f.db.exec("UPDATE agents SET responsible_user_id = 'buyer'")
    );
    // Defense in depth if an imported/legacy database contains an orphan.
    f.db.exec(
      "PRAGMA foreign_keys = OFF; DELETE FROM users WHERE id = 'seller'"
    );
    assert.throws(() => f.auth.authorize(live, read), ForbiddenError);
  } finally {
    f.db.close();
  }
});

test("HTTP middleware returns uniform errors and never trusts duplicate or replayed identity headers", () => {
  const f = fixture();
  try {
    const allowed = http(f.auth, f.agent);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.identity.kind, "agent");
    assert.equal(allowed.headers.get("Cache-Control"), "no-store");
    const cases = [
      http(f.auth, null),
      http(f.auth, f.agent, "/api/access/contract/contract-b"),
      http(f.auth, f.agent, "/api/access/contract/missing"),
      http(f.auth, f.admin),
      http(f.auth, f.agent, undefined, ["authorization", "Bearer " + f.agent]),
      http(f.auth, null, undefined, ["X-User-Id", "seller", "X-Role", "admin"])
    ];
    for (const result of cases) {
      assert.equal(result.status, 403);
      assert.deepEqual(result.body.error, {
        code: "FORBIDDEN",
        message: "无权访问"
      });
    }
    const repeat = http(f.auth, f.agent, undefined, [
      "X-Request-Id",
      allowed.body.request_id
    ]);
    assert.equal(repeat.status, 200);
    assert.notEqual(repeat.body.request_id, allowed.body.request_id);
    f.auth.revoke(f.seller, tokenDigest(f.agent));
    assert.equal(
      http(f.auth, f.agent, undefined, [
        "X-Request-Id",
        allowed.body.request_id
      ]).status,
      403
    );
    assert.equal(http(f.auth, f.buyer).body.data.identity.id, "buyer");
  } finally {
    f.db.close();
  }
});

test("stored credentials and audit records contain only token digests", () => {
  const f = fixture();
  try {
    const serialized = JSON.stringify({
      rows: f.db.prepare("SELECT * FROM credentials").all(),
      events: f.events
    });
    for (const token of [f.buyer, f.seller, f.admin, f.agent])
      assert.ok(!serialized.includes(token));
    for (const event of f.events) {
      assert.deepEqual(Object.keys(event).sort(), ["event", "tokenDigest"]);
      assert.match(event.tokenDigest, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(f.store.agent("agent-a")?.capabilities, [
      "typescript",
      "testing"
    ]);
    assert.throws(() =>
      f.db.exec(
        "INSERT INTO memberships VALUES ('buyer', 'org-a', 'project-b', 'buyer')"
      )
    );
  } finally {
    f.db.close();
  }
});

test("agent scope does not inherit owner grants, organization or project access", () => {
  const f = fixture();
  try {
    const grant = f.db.prepare(
      "INSERT INTO resource_grants VALUES ('seller', ?, ?, 'read')"
    );
    for (const [kind, id] of [
      ["secret", "secret-a"],
      ["production", "production-a"],
      ["repository", "private-a"],
      ["contract", "contract-other"]
    ] as const) {
      grant.run(kind, id);
      const scope: Scope = { kind, resourceId: id, action: "read" };
      assert.equal(f.auth.authorize(f.seller, scope).identity.kind, "user");
      assert.throws(() => f.auth.authorize(f.agent, scope), ForbiddenError);
    }
    for (const kind of ["organization", "project"] as const) {
      const resourceId = kind === "organization" ? "org-a" : "project-a";
      assert.equal(
        http(f.auth, f.buyer, `/api/access/${kind}/${resourceId}`).status,
        200
      );
      assert.equal(
        http(
          f.auth,
          f.buyer,
          `/api/access/${kind}/${
            kind === "organization" ? "org-b" : "project-b"
          }`
        ).status,
        403
      );
      const parent = f.auth.issueAgentToken(f.seller, "agent-a", [
        { kind, resourceId, action: "read" }
      ]);
      assert.throws(() => f.auth.authorize(parent, read), ForbiddenError);
    }
    f.advance(1000);
    assert.deepEqual(http(f.auth, f.agent).body.error, {
      code: "FORBIDDEN",
      message: "无权访问"
    });
  } finally {
    f.db.close();
  }
});
