import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { Disputes } from "../packages/database/src/disputes.js";
import { ForbiddenError, tokenDigest } from "../packages/auth/src/index.js";
import { disputeRoute } from "../apps/server/src/disputes.js";
import { handleRequest } from "../apps/server/src/app.js";

function fixture() {
  const f = setup();
  const agent = f.auth.issueAgentToken(f.seller, "agent-a", [
    { kind: "contract", resourceId: f.current().id, action: "read" },
    { kind: "contract", resourceId: f.current().id, action: "write" }
  ]);
  f.db
    .prepare(
      "DELETE FROM resource_grants WHERE resource_kind='contract' AND resource_id=? AND action='delegate'"
    )
    .run(f.current().id);
  for (const token of [f.buyer, f.seller])
    assert.throws(
      () =>
        f.auth.authorize(token, {
          kind: "contract",
          resourceId: f.current().id,
          action: "delegate"
        }),
      ForbiddenError
    );
  f.activate();
  f.command(f.buyer, "transition", { to: "disputed" });
  let now = 1000;
  const service = new Disputes(f.db, f.auth, () => now);
  const admin = f.auth.issueUserSession("admin");
  const id = service.create(f.buyer, f.current().id, true).id;
  const grant = () =>
    service.grant(f.buyer, id, {
      adminId: "admin",
      scope: "audit_and_evidence:read",
      expiresAt: 2000,
      confirmed: true
    });
  return {
    ...f,
    service,
    agent,
    admin,
    id,
    grant,
    tick: () => {
      now = 2000;
      f.advance(1000);
    }
  };
}

test("case grants require explicit human party consent and current membership; expiry and revocation fail closed", () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.read(f.admin, f.id), ForbiddenError);
    for (const token of [
      f.admin,
      f.second,
      f.auth.issueUserSession("outsider")
    ]) {
      assert.throws(
        () => f.service.create(token, f.current().id, true),
        ForbiddenError
      );
      assert.throws(() => f.service.grant(token, f.id, {}), ForbiddenError);
      assert.throws(() => f.service.submit(token, f.id, {}), ForbiddenError);
    }
    assert.throws(
      () => f.service.grant(f.buyer, f.id, { adminId: "admin" }),
      /CONFIRMATION_REQUIRED/
    );
    assert.throws(
      () =>
        f.service.grant(f.buyer, f.id, {
          adminId: "admin",
          confirmed: true,
          scope: "write",
          expiresAt: 2000
        }),
      /INVALID_GRANT/
    );
    const grant = f.grant();
    assert.equal(grant.grantedBy, "buyer");
    const audit = f.db
      .prepare(
        "SELECT * FROM audit_events WHERE event='Disputes.grant' AND result='success'"
      )
      .get()!;
    assert.equal(audit.actor_id, "user:buyer");
    assert.equal(audit.target_subject, "user:admin");
    assert.equal(audit.permission, "audit_and_evidence:read");
    assert.equal(audit.permission_expires_at, 2000);
    const agent = f.agent;
    assert.throws(() => f.service.grant(agent, f.id, {}), ForbiddenError);
    assert.throws(() => f.service.submit(agent, f.id, {}), ForbiddenError);
    f.db.exec("UPDATE users SET platform_role='member' WHERE id='admin'");
    assert.throws(() => f.service.read(f.admin, f.id), ForbiddenError);
    f.db.exec("UPDATE users SET platform_role='admin' WHERE id='admin'");

    assert.equal(f.service.read(f.admin, f.id).id, f.id);
    f.db.exec(
      "DELETE FROM memberships WHERE user_id='admin' AND project_id='project-a'"
    );
    assert.throws(() => f.service.read(f.admin, f.id), ForbiddenError);
    f.db.exec(
      "INSERT INTO memberships VALUES ('admin','org-a','project-a','admin')"
    );
    f.service.revoke(f.seller, f.id, grant.id);
    assert.throws(
      () => new Disputes(f.db, f.auth).read(f.admin, f.id),
      ForbiddenError
    );
    f.grant();
    f.tick();
    assert.throws(() => f.service.read(f.admin, f.id), ForbiddenError);
    assert.throws(
      () =>
        f.auth.authorize(f.admin, {
          kind: "dispute",
          resourceId: f.id,
          action: "read"
        }),
      ForbiddenError
    );
  } finally {
    f.db.close();
  }
});

test("case view isolates evidence references and sanitized audit, records every read and preserves frozen business state", () => {
  const f = fixture();
  try {
    f.grant();
    const before = f.contracts.read(f.buyer, f.current().id);
    const sequences = before.events.map(e => e.sequence);
    f.service.submit(f.buyer, f.id, {
      eventSequence: sequences[0],
      confirmed: true
    });
    f.service.submit(f.seller, f.id, {
      eventSequence: sequences[1],
      confirmed: true
    });
    assert.throws(
      () => f.service.submit(f.seller, f.id, { eventSequence: sequences[2] }),
      /CONFIRMATION_REQUIRED/
    );
    const other = f.contracts.select(
      f.buyer,
      f.submit(f.seller, f.publish()).id,
      true
    );
    f.db
      .prepare("UPDATE contracts SET status='disputed' WHERE id=?")
      .run(other.id);
    const otherId = f.service.create(f.buyer, other.id, true).id;
    assert.throws(
      () =>
        f.service.submit(f.buyer, f.id, {
          eventSequence: other.events[0]!.sequence,
          confirmed: true
        }),
      ForbiddenError
    );
    assert.throws(() => f.service.read(f.admin, otherId), ForbiddenError);
    const view = f.service.read(f.admin, f.id);
    f.service.read(f.admin, f.id);
    assert.equal(view.evidence.length, 2);
    for (const row of view.evidence)
      assert.deepEqual(Object.keys(row).sort(), [
        "created_at",
        "event_sequence",
        "id",
        "party"
      ]);
    assert.deepEqual(
      new Set(view.evidence.map(e => e.party)),
      new Set(["buyer", "seller"])
    );
    assert.ok(view.audit.length > 0);
    for (const row of view.audit)
      assert.deepEqual(Object.keys(row).sort(), [
        "created_at",
        "event",
        "result",
        "sequence"
      ]);
    assert.ok(!JSON.stringify(view).includes(other.id));
    assert.ok(!JSON.stringify(view).includes(before.versions[0]!.terms.scope));
    assert.ok(!JSON.stringify(view).includes("payload"));
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE event='Disputes.read' AND result='success' AND object_id=? AND actor_id='user:admin'"
        )
        .get(f.id)!.n,
      2
    );
    assert.deepEqual(f.contracts.read(f.buyer, f.current().id), before);
    for (const [kind, resourceId] of [
      ["contract", f.current().id],
      ["workspace", "workspace-a"],
      ["repository", "private-a"]
    ] as const)
      assert.throws(
        () => f.auth.authorize(f.admin, { kind, resourceId, action: "read" }),
        ForbiddenError
      );
    assert.throws(() => f.command(f.buyer, "settlement"), /DISPUTE_FROZEN/);
    const workspaces = new Workspaces(f.db, f.auth, () => 1000);
    for (const token of [f.buyer, f.seller, f.agent])
      assert.throws(
        () =>
          workspaces.command(token, f.current().id, {
            action: "authorize",
            confirmed: true,
            version: f.current().version,
            requestKey: "frozen-case",
            actorId: "agent-a",
            permission: "check",
            ttlMs: 1000
          }),
        token === f.agent ? ForbiddenError : /CONTRACT_NOT_ACTIVE/
      );
    assert.deepEqual(f.contracts.read(f.buyer, f.current().id), before);
    f.db.exec(
      "CREATE TRIGGER deny_case_audit BEFORE INSERT ON audit_events WHEN NEW.event='Disputes.read' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
    );
    assert.throws(() => f.service.read(f.admin, f.id), /audit unavailable/);
  } finally {
    f.db.close();
  }
});

test("HTTP case entry uses uniform denial, no-store and read-only HTML", async () => {
  const f = fixture();
  const call = async (path: string, token = f.admin, body?: unknown) => {
    const request = Readable.from(
      body ? [JSON.stringify(body)] : []
    ) as IncomingMessage;
    request.url = path;
    request.method = body ? "POST" : "GET";
    request.headers = { "content-type": "application/json" };
    request.rawHeaders = ["Authorization", "Bearer " + token];
    let output = "";
    const headers = new Map<string, string>();
    const response = {
      statusCode: 200,
      setHeader: (key: string, value: string) => headers.set(key, value),
      end: (value: string) => {
        output = value;
      }
    };
    if (path.startsWith("/api"))
      await disputeRoute(
        request,
        (response as unknown) as ServerResponse,
        "offline-request",
        f.service
      );
    else
      handleRequest(
        request,
        (response as unknown) as ServerResponse,
        f.auth,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service
      );
    return { status: response.statusCode, output, headers };
  };
  try {
    const denied = await call("/api/disputes/" + f.id);
    const missing = await call("/api/disputes/missing");
    assert.equal(denied.status, 403);
    assert.deepEqual(
      JSON.parse(denied.output).error,
      JSON.parse(missing.output).error
    );
    const input = {
      adminId: "admin",
      scope: "audit_and_evidence:read",
      expiresAt: 2000,
      confirmed: true
    };
    const grantPath = `/api/disputes/${f.id}/grants`;
    const permissions = () => ({
      grants: f.db
        .prepare(
          "SELECT * FROM resource_grants ORDER BY user_id, resource_kind, resource_id, action"
        )
        .all(),
      memberships: f.db
        .prepare(
          "SELECT * FROM memberships ORDER BY user_id, organization_id, project_id"
        )
        .all(),
      agents: f.db.prepare("SELECT * FROM agents ORDER BY id").all()
    });
    const beforePermissions = permissions();
    const revoked = f.auth.issueUserSession("buyer");
    f.auth.revoke(f.buyer, tokenDigest(revoked));
    const expired = f.auth.issueUserSession("seller", 1);
    f.advance(1);
    // Give a non-party full contract rights: identity must still match the contract.
    f.db
      .prepare(
        "INSERT INTO resource_grants VALUES ('seller-two','contract',?,'write')"
      )
      .run(f.current().id);
    for (const token of [
      f.second,
      f.admin,
      f.agent,
      revoked,
      expired,
      "invalid-session"
    ])
      assert.equal((await call(grantPath, token, input)).status, 403);
    f.db
      .prepare(
        "DELETE FROM resource_grants WHERE user_id='seller-two' AND resource_kind='contract' AND resource_id=?"
      )
      .run(f.current().id);
    for (const [token, user] of [
      [f.buyer, "buyer"],
      [f.seller, "seller"]
    ]) {
      for (const confirmed of [undefined, false, "true"])
        assert.equal(
          JSON.parse(
            (await call(grantPath, token, { ...input, confirmed })).output
          ).error.code,
          "CONFIRMATION_REQUIRED"
        );
      f.db
        .prepare(
          "DELETE FROM resource_grants WHERE user_id=? AND resource_kind='contract' AND resource_id=? AND action='write'"
        )
        .run(user!, f.current().id);
      assert.equal((await call(grantPath, token, input)).status, 403);
      f.db
        .prepare("INSERT INTO resource_grants VALUES (?,'contract',?,'write')")
        .run(user!, f.current().id);
    }
    for (const sql of [
      "UPDATE users SET platform_role='member' WHERE id='admin'",
      "DELETE FROM memberships WHERE user_id='admin' AND project_id='project-a'",
      "DELETE FROM memberships WHERE user_id='admin' AND project_id=''"
    ]) {
      f.db.exec("SAVEPOINT qualification");
      f.db.exec(sql);
      assert.equal((await call(grantPath, f.buyer, input)).status, 403);
      f.db.exec("ROLLBACK TO qualification");
      f.db.exec("RELEASE qualification");
    }
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM dispute_grants").get()!.n,
      0
    );
    const sellerGrant = await call(grantPath, f.seller, input);
    assert.equal(sellerGrant.status, 200);
    assert.equal(JSON.parse(sellerGrant.output).data.grantedBy, "seller");
    assert.equal((await call(`/api/disputes/${f.id}`)).status, 200);
    await call(`/api/disputes/${f.id}/revoke`, f.seller, {
      grantId: JSON.parse(sellerGrant.output).data.id
    });
    assert.equal((await call(`/api/disputes/${f.id}`)).status, 403);
    assert.deepEqual(permissions(), beforePermissions);
    assert.throws(
      () =>
        f.auth.issueAgentToken(f.seller, "agent-a", [
          { kind: "contract", resourceId: f.current().id, action: "write" }
        ]),
      ForbiddenError
    );
    const granted = await call(`/api/disputes/${f.id}/grants`, f.buyer, {
      adminId: "admin",
      scope: "audit_and_evidence:read",
      expiresAt: 2000,
      confirmed: true
    });
    assert.equal(granted.status, 200);
    assert.deepEqual(permissions(), beforePermissions);
    const html = await call("/disputes/" + f.id);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("Cache-Control"), "no-store");
    assert.match(html.output, /争议案件（只读）/);
    assert.ok(!html.output.includes("<form"));
    await call(`/api/disputes/${f.id}/revoke`, f.buyer, {
      grantId: JSON.parse(granted.output).data.id
    });
    assert.deepEqual(
      JSON.parse((await call("/api/disputes/" + f.id)).output).error,
      JSON.parse(denied.output).error
    );
    f.grant();
    f.tick();
    assert.deepEqual(
      JSON.parse((await call("/api/disputes/" + f.id)).output).error,
      JSON.parse(denied.output).error
    );
  } finally {
    f.db.close();
  }
});
