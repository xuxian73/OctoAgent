import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { setup } from "./fixtures/contracts.js";
import { Agents } from "../packages/database/src/agents.js";
import { handleRequest } from "../apps/server/src/app.js";
import {
  Authorization,
  csrfToken,
  MAX_AGENT_TTL_MS
} from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { MarketplaceMcp } from "../packages/mcp/src/index.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { McpRequests } from "../packages/database/src/mcp.js";
import { Onboarding } from "../packages/database/src/onboarding.js";

test("authenticated Agent management page reaches its forms through the application router", () => {
  const f = setup();
  try {
    f.db.prepare("INSERT INTO users VALUES (?, 'member')").run("new-owner");
    const newOwner = f.auth.issueUserSession("new-owner");
    const agent = f.auth.issueAgentToken(f.seller, "agent-a");
    for (const token of [f.seller, f.buyer, newOwner, agent, ""]) {
      const request = {
        url: "/agents",
        method: "GET",
        headers: {},
        rawHeaders: ["Cookie", "octo_session=" + token]
      } as IncomingMessage;
      let html = "";
      const response = {
        statusCode: 200,
        setHeader() {},
        end(body: string) {
          html = body;
        }
      };
      handleRequest(
        request,
        (response as unknown) as ServerResponse,
        f.auth,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new Onboarding(f.db, f.auth)
      );
      if (token === agent || token === "") {
        assert.equal(response.statusCode, 303);
        assert.doesNotMatch(html, /id="create-agent"/);
        continue;
      }
      assert.equal(response.statusCode, 200);
      assert.match(html, /id="create-agent"/);
      assert.match(html, /id="issue-agent"/);
      assert.match(html, /src="\/agents.js"/);
      assert.match(html, /id="logout"/);
      assert.doesNotMatch(html, /id="onboarding"/);
    }
  } finally {
    f.db.close();
  }
});

test("owner API creates agents, confirms bounded scopes, isolates credentials and revokes MCP immediately", async () => {
  const f = setup();
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(f.db), () => now);
  const owner = auth.issueUserSession("seller");
  const other = auth.issueUserSession("buyer");
  const service = new Agents(f.db, auth);
  const call = (
    path: string,
    method = "GET",
    input?: unknown,
    token = owner,
    csrf = true
  ) =>
    new Promise<{ status: number; data: any; raw: string }>(resolve => {
      const request = Readable.from(
        input === undefined ? [] : [JSON.stringify(input)]
      ) as IncomingMessage;
      request.url = path;
      request.method = method;
      request.headers = {
        cookie: "octo_session=" + token,
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrfToken(token) } : {})
      };
      request.rawHeaders = Object.entries(request.headers).flat() as string[];
      const response = {
        statusCode: 200,
        setHeader() {},
        end(raw: string) {
          resolve({ status: this.statusCode, data: JSON.parse(raw), raw });
        }
      };
      handleRequest(
        request,
        (response as unknown) as ServerResponse,
        auth,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        service
      );
    });
  try {
    const created = await call("/api/agents", "POST", {
      kind: "seller",
      capabilities: ["production", "typescript"]
    });
    assert.equal(created.status, 200);
    const agent = created.data.data;
    assert.equal(agent.responsibleUserId, "seller");
    const path = "/api/agents/" + agent.id + "/credentials";
    const scope = { kind: "project", resourceId: "project-a", action: "read" };
    const input = { scopes: [scope], ttlMs: MAX_AGENT_TTL_MS, confirmed: true };
    for (const invalid of [
      null,
      [],
      { ...scope, action: ["read"] },
      { ...scope, resourceId: 1 },
      { ...scope, kind: null },
      { ...scope, responsibleUserId: "buyer" }
    ]) {
      assert.equal(
        (await call(path, "POST", { ...input, scopes: [invalid] })).status,
        400
      );
    }
    assert.equal(
      (await call(path, "POST", { ...input, confirmed: false })).status,
      400
    );
    for (const ttlMs of [0, -1, 1.5, MAX_AGENT_TTL_MS + 1])
      assert.equal((await call(path, "POST", { ...input, ttlMs })).status, 403);
    assert.equal((await call(path, "POST", input, other)).status, 403);
    assert.equal((await call(path, "POST", input, owner, false)).status, 403);
    assert.equal(
      (
        await call("/api/agents", "POST", {
          kind: "seller",
          capabilities: [],
          responsibleUserId: "buyer"
        })
      ).status,
      400
    );
    for (const scopes of [
      [{ ...scope, resourceId: "project-b" }],
      [{ ...scope, action: "delegate" }],
      [{ kind: "production", resourceId: "production-a", action: "read" }]
    ])
      assert.equal(
        (await call(path, "POST", { ...input, scopes })).status,
        403
      );
    const issued = (await call(path, "POST", input)).data.data;
    assert.equal(issued.expiresAt, now + MAX_AGENT_TTL_MS);
    const mcp = new MarketplaceMcp({
      auth,
      requirements: f.req,
      market: f.market,
      contracts: f.contracts,
      workspaces: new Workspaces(f.db, auth),
      requests: new McpRequests(f.db)
    });
    assert.doesNotThrow(() => auth.agentIdentity(issued.token));
    assert.equal(
      (await call("/api/agents", "GET", undefined, issued.token)).status,
      403
    );
    assert.throws(() =>
      service.create(issued.token, { kind: "buyer", capabilities: [] })
    );
    assert.throws(() => service.issue(issued.token, agent.id, input));
    assert.throws(() => service.revoke(issued.token, agent.id, issued.id));
    assert.equal(
      (await call(path + "/" + issued.id, "DELETE", undefined, other)).status,
      403
    );
    assert.ok(!service.list(other).agents.some(a => a.id === agent.id));
    assert.equal((await call(path + "/" + issued.id, "DELETE")).status, 200);
    assert.throws(() => auth.agentIdentity(issued.token));
    assert.ok(mcp.call(issued.token, "search_tasks", {}).error);
    assert.equal(
      service.list(owner).agents.find(a => a.id === agent.id)!.credentials[0]!
        .revoked,
      true
    );
    const expiring = service.issue(owner, agent.id, { ...input, ttlMs: 100 });
    now += 100;
    assert.throws(() => auth.agentIdentity(expiring.token));
    assert.ok(mcp.call(expiring.token, "search_tasks", {}).error);
    for (const action of ["delegate", "read"]) {
      f.db.exec("SAVEPOINT grants");
      f.db
        .prepare(
          "DELETE FROM resource_grants WHERE user_id='seller' AND action=?"
        )
        .run(action);
      assert.equal((await call(path, "POST", input)).status, 403);
      assert.ok(
        !service
          .list(owner)
          .scopes.some(
            s =>
              s.kind === scope.kind &&
              s.resourceId === scope.resourceId &&
              s.action === scope.action
          )
      );
      f.db.exec("ROLLBACK TO grants; RELEASE grants");
    }
    const serialized = JSON.stringify({
      list: service.list(owner),
      audit: f.db.prepare("SELECT * FROM audit_events").all(),
      requests: f.db.prepare("SELECT * FROM business_requests").all(),
      credentials: f.db.prepare("SELECT * FROM credentials").all()
    });
    for (const token of [issued.token, expiring.token, owner, other])
      assert.ok(!serialized.includes(token));
    f.db.exec(
      "CREATE TRIGGER fail_agent_audit BEFORE INSERT ON audit_events WHEN NEW.event='Agents.issue' AND NEW.result='success' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
    );
    const count = f.db.prepare("SELECT count(*) n FROM credentials").get()!.n;
    assert.equal((await call(path, "POST", input)).status, 500);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM credentials").get()!.n,
      count
    );
  } finally {
    f.db.close();
  }
});

test("page confirms exact scope and owner before issuing and clears the one-time result", async () => {
  const { mountAgents, renderAgents } = await import(
    "../apps/web/src/agents.js"
  );
  class Element extends EventTarget {
    value = "";
    textContent = "";
    checked = false;
    children: unknown[] = [];
    append(...children: unknown[]) {
      this.children.push(...children);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const nodes = new Map(
    [
      "create-agent",
      "issue-agent",
      "owner",
      "agent-id",
      "agent-list",
      "scopes",
      "status",
      "ttl",
      "issued-token",
      "hide-token",
      "scope-0"
    ].map(id => [id, new Element()])
  );
  const root = ({
    getElementById: (id: string) => nodes.get(id),
    createElement: () => new Element(),
    createTextNode: (s: string) => s
  } as unknown) as Document;
  const previous = globalThis.fetch;
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  let approved = false;
  let submissions = 0;
  let summary = "";
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      };
    if (options?.method === "POST") {
      submissions++;
      assert.deepEqual(JSON.parse(String(options.body)), {
        scopes: [{ kind: "project", resourceId: "project-a", action: "read" }],
        ttlMs: 900000,
        confirmed: true
      });
      return { json: async () => ({ ok: true, data: { token } }) };
    }
    return {
      json: async () => ({
        ok: true,
        data: {
          responsibleUserId: "seller",
          agents: [],
          scopes: [{ kind: "project", resourceId: "project-a", action: "read" }]
        }
      })
    };
  }) as typeof fetch;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    assert.match(renderAgents(), /能力标签仅描述能力/);
    mountAgents(root, message => {
      summary = message;
      return approved;
    });
    await tick();
    nodes.get("agent-id")!.value = "synthetic-agent";
    nodes.get("ttl")!.value = "15";
    nodes.get("scope-0")!.checked = true;
    nodes.get("issue-agent")!.dispatchEvent(new Event("submit"));
    await tick();
    assert.equal(submissions, 0);
    assert.match(summary, /seller/);
    assert.match(summary, /project-a/);
    assert.match(summary, /15/);
    approved = true;
    nodes.get("issue-agent")!.dispatchEvent(new Event("submit"));
    await tick();
    assert.equal(submissions, 1);
    assert.equal(nodes.get("issued-token")!.textContent, token);
    nodes.get("hide-token")!.dispatchEvent(new Event("click"));
    assert.equal(nodes.get("issued-token")!.textContent, "");
  } finally {
    globalThis.fetch = previous;
  }
});
