import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { Authorization, csrfToken } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { Onboarding } from "../packages/database/src/onboarding.js";
import { Requirements } from "../packages/database/src/requirements.js";
import { handleRequest } from "../apps/server/src/app.js";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import {
  renderOnboarding,
  mountOnboarding,
  mountProjectContext
} from "../apps/web/src/onboarding.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  db.exec(
    "INSERT INTO users(id) VALUES ('new-user'), ('other-user'); INSERT INTO agents VALUES ('synthetic-agent','new-user','buyer','[]')"
  );
  const auth = new Authorization(new SqliteIdentityStore(db));
  const token = auth.issueUserSession("new-user");
  const service = new Onboarding(db, auth);
  const requirements = new Requirements(db, auth);
  const body = { organizationName: "测试组织", projectName: "测试项目" };
  const call = (
    path: string,
    method = "GET",
    input?: unknown,
    credential = token,
    extra: Record<string, string> = {}
  ) =>
    new Promise<{ status: number; body: any; headers: Record<string, string> }>(
      resolve => {
        const request = Readable.from(
          input === undefined ? [] : [JSON.stringify(input)]
        ) as IncomingMessage;
        request.url = path;
        request.method = method;
        request.headers = {
          "content-type": "application/json",
          ...(credential
            ? {
                cookie: "octo_session=" + credential,
                "x-csrf-token": csrfToken(credential)
              }
            : {}),
          ...extra
        };
        request.rawHeaders = Object.entries(request.headers).flat() as string[];
        const headers: Record<string, string> = {};
        const response = {
          statusCode: 200,
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
          end(value = "") {
            resolve({
              status: this.statusCode,
              body: headers["Content-Type"]?.includes("json")
                ? JSON.parse(value)
                : value,
              headers
            });
          }
        };
        handleRequest(
          request,
          (response as unknown) as ServerResponse,
          auth,
          requirements,
          undefined,
          undefined,
          undefined,
          undefined,
          service
        );
      }
    );
  const create = (
    key = "synthetic-first-use",
    input: unknown = body,
    credential = token
  ) =>
    call("/api/onboarding", "POST", input, credential, {
      "idempotency-key": key
    });
  return { db, auth, token, service, requirements, body, call, create };
}

test("contract-only grants expose the project and actual business pages without project read", async () => {
  const f = setup();
  const contexts = new Onboarding(f.db, f.auth);
  const workspaces = new Workspaces(f.db, f.auth, () => 1000);
  const call = (path: string, token = f.seller) =>
    new Promise<{ status: number; body: string }>(resolve => {
      const request = Readable.from([]) as IncomingMessage;
      request.url = path;
      request.method = "GET";
      request.headers = { cookie: "octo_session=" + token };
      request.rawHeaders = ["Cookie", request.headers.cookie!];
      const response = {
        statusCode: 200,
        setHeader() {},
        end(body = "") {
          resolve({ status: this.statusCode, body });
        }
      };
      handleRequest(
        request,
        (response as unknown) as ServerResponse,
        f.auth,
        f.req,
        f.market,
        f.contracts,
        workspaces,
        undefined,
        contexts
      );
    });
  try {
    f.db.exec(
      "DELETE FROM resource_grants WHERE user_id='seller' AND resource_kind='project'"
    );
    assert.deepEqual(
      contexts.list(f.seller).projects.map(p => [p.id, p.pages]),
      [["project-a", ["contracts"]]]
    );
    assert.equal((await call("/workspaces?project=project-a")).status, 403);
    f.activate();
    const id = f.current().id;
    assert.equal(f.contracts.read(f.seller, id).id, id);
    assert.equal(workspaces.read(f.seller, id).contractId, id);
    const listed = JSON.parse((await call("/api/contexts")).body).data.projects;
    assert.deepEqual(
      listed.map((p: { id: string; pages: string[] }) => [p.id, p.pages]),
      [["project-a", ["contracts", "workspaces"]]]
    );
    for (const page of ["contracts", "workspaces"]) {
      const result = await call(`/${page}?project=project-a`);
      assert.equal(result.status, 200);
      assert.match(result.body, /id="contract"/);
      assert.match(result.body, /value="project-a"/);
      assert.match(result.body, /href="\/contracts\?project=project-a"/);
      assert.match(result.body, /href="\/workspaces\?project=project-a"/);
      assert.doesNotMatch(
        result.body,
        /href="\/(requirements|market)\?|id="session"/
      );
    }
    for (const page of ["requirements", "market"])
      assert.equal((await call(`/${page}?project=project-a`)).status, 403);
    assert.equal((await call("/contracts?project=project-b")).status, 403);
    assert.equal((await call(`/api/contracts/${id}`)).status, 200);
    assert.equal((await call(`/api/workspaces/${id}`)).status, 200);
    for (const mutation of [
      "DELETE FROM resource_grants WHERE user_id='seller' AND resource_kind='contract'",
      "DELETE FROM memberships WHERE user_id='seller' AND project_id='project-a'",
      "DELETE FROM memberships WHERE user_id='seller' AND project_id=''",
      "UPDATE memberships SET role='buyer' WHERE user_id='seller' AND project_id='project-a'"
    ]) {
      f.db.exec("SAVEPOINT revoke_context");
      f.db.exec(mutation);
      assert.equal(contexts.list(f.seller).projects.length, 0);
      for (const page of ["contracts", "workspaces"]) {
        const denied = await call(`/${page}?project=project-a`);
        assert.equal(
          denied.status,
          contexts.list(f.seller).canInitialize ? 303 : 403
        );
        assert.doesNotMatch(denied.body, /id="contract"/);
        assert.equal((await call(`/api/${page}/${id}`)).status, 403);
      }
      f.db.exec("ROLLBACK TO revoke_context; RELEASE revoke_context");
    }
    // A grant alone does not make a non-party a contract participant.
    f.db
      .prepare(
        "INSERT INTO resource_grants VALUES ('seller-two','contract',?,'read')"
      )
      .run(id);
    f.db.exec(
      "DELETE FROM resource_grants WHERE user_id='seller-two' AND resource_kind='project'"
    );
    assert.equal(contexts.list(f.second).projects.length, 0);
    assert.equal(
      (await call("/contracts?project=project-a", f.second)).status,
      403
    );
  } finally {
    f.db.close();
  }
});

test("new human account reaches onboarding, creates a project and can save a draft without seeds", async () => {
  const f = fixture();
  try {
    assert.equal((await f.call("/console")).headers.Location, "/onboarding");
    assert.match((await f.call("/onboarding")).body, /创建首个项目/);
    const first = await f.create();
    assert.equal(first.status, 200);
    assert.deepEqual((await f.create()).body.data, first.body.data);
    assert.equal((await f.create("another-key")).status, 409);
    assert.equal(
      (
        await f.create("synthetic-first-use", {
          ...f.body,
          projectName: "不同项目"
        })
      ).status,
      409
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM organizations").get()!.n,
      1
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM resource_grants").get()!.n,
      3
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM memberships").get()!.n,
      2
    );
    const contexts = (await f.call("/api/contexts")).body.data;
    assert.equal(contexts.organizations[0].name, f.body.organizationName);
    assert.equal(contexts.projects[0].id, first.body.data.projectId);
    assert.equal(contexts.canInitialize, false);
    const draft = await f.call("/api/requirements", "POST", {
      projectId: first.body.data.projectId,
      draft: { values: {}, publicFields: [] }
    });
    assert.equal(draft.status, 200);
    assert.ok(draft.body.data.validation.missing.length > 0);
    assert.equal((await f.call("/console")).status, 200);
    const grants = f.db
      .prepare("SELECT * FROM audit_events WHERE event='permission.granted'")
      .all();
    assert.equal(grants.length, 3);
    for (const row of grants) {
      assert.equal(row.actor_id, "user:new-user");
      assert.equal(row.target_subject, "user:new-user");
      assert.equal(row.tenant_id, first.body.data.organizationId);
      assert.equal(row.permission_action, "grant");
      assert.equal(row.permission_expires_at, null);
    }
  } finally {
    f.db.close();
  }
});

test("initialization rejects anonymous, agents, forged identity fields, invalid names and missing CSRF/key", async () => {
  const f = fixture();
  try {
    const agent = f.auth.issueAgentToken(f.token, "synthetic-agent");
    for (const token of ["", agent]) {
      assert.equal((await f.create("key", f.body, token)).status, 403);
      assert.equal(
        (await f.call("/api/contexts", "GET", undefined, token)).status,
        403
      );
      assert.equal(
        (await f.call("/onboarding", "GET", undefined, token)).status,
        303
      );
    }
    for (const input of [
      { ...f.body, userId: "other-user" },
      { ...f.body, role: "admin" },
      { ...f.body, projectName: " " },
      { ...f.body, organizationName: "a".repeat(81) },
      null,
      []
    ]) {
      assert.equal((await f.create("key", input)).status, 400);
    }
    assert.equal((await f.call("/api/onboarding", "POST", f.body)).status, 400);
    assert.equal(
      (
        await f.call("/api/onboarding", "POST", f.body, f.token, {
          "idempotency-key": "key",
          "x-csrf-token": "invalid"
        })
      ).status,
      403
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM organizations").get()!.n,
      0
    );
  } finally {
    f.db.close();
  }
});

test("contexts are tenant isolated and membership or grant removal takes effect on lists and replay", async () => {
  for (const removal of [
    "DELETE FROM memberships WHERE user_id='new-user' AND project_id != ''",
    "DELETE FROM memberships WHERE user_id='new-user' AND project_id = ''",
    "DELETE FROM resource_grants WHERE user_id='new-user' AND resource_kind='project' AND action='read'"
  ]) {
    const f = fixture();
    try {
      const created = await f.create();
      const other = f.auth.issueUserSession("other-user");
      assert.equal(
        (await f.call("/api/contexts", "GET", undefined, other)).body.data
          .projects.length,
        0
      );
      assert.equal(
        (await f.create("synthetic-first-use", f.body, other)).status,
        200
      );
      assert.equal(f.service.list(f.token).projects.length, 1);
      f.db.exec(removal);
      const list = f.service.list(f.token);
      assert.equal(list.projects.length, 0);
      assert.equal(list.canInitialize, false);
      assert.equal((await f.create()).status, 403);
      assert.equal((await f.create("new-key")).status, 409);
      assert.throws(() =>
        f.requirements.create(f.token, created.body.data.projectId, {
          values: {},
          publicFields: []
        })
      );
    } finally {
      f.db.close();
    }
  }
});

test("failure of any creation audit atomically rolls back resources, membership, grants and idempotency", async () => {
  for (const event of [
    "membership.created",
    "permission.granted",
    "Onboarding.create"
  ]) {
    const f = fixture();
    try {
      f.db.exec(
        `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.event='${event}' AND NEW.result='success' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`
      );
      assert.equal((await f.create()).status, 500);
      for (const table of [
        "organizations",
        "projects",
        "account_onboarding",
        "memberships",
        "authorization_resources",
        "resource_grants",
        "business_requests"
      ])
        assert.equal(
          f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,
          0,
          table
        );
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) n FROM audit_events WHERE event IN ('permission.granted','membership.created')"
          )
          .get()!.n,
        0
      );
      f.db.exec("DROP TRIGGER fail_audit");
      assert.equal((await f.create()).status, 200);
    } finally {
      f.db.close();
    }
  }
});

test("onboarding UI retries with the same key and populates only authorized context options", async () => {
  class Element extends EventTarget {
    value = "";
    textContent = "";
    disabled = false;
    tagName = "SELECT";
    children: Element[] = [];
    append(child: Element) {
      this.children.push(child);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const elements = new Map(
    [
      "onboarding-form",
      "onboarding-status",
      "initialize",
      "organization-name",
      "project-name",
      "project",
      "status"
    ].map(id => [id, new Element()])
  );
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Element()
  } as unknown) as Document;
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location"
  );
  const destinations: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      href: "http://localhost/requirements?project=allowed",
      assign: (url: string) => destinations.push(url)
    }
  });
  const submissions: RequestInit[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      };
    if (url === "/api/contexts")
      return {
        json: async () => ({
          ok: true,
          data: {
            projects: [
              { id: "allowed", name: "<test>", organizationId: "org" }
            ],
            organizations: [{ id: "org", name: "测试" }]
          }
        })
      };
    submissions.push(options!);
    if (submissions.length === 1) throw new Error("synthetic disconnect");
    return { json: async () => ({ ok: true, data: { projectId: "allowed" } }) };
  }) as typeof fetch;
  try {
    assert.match(renderOnboarding(), /maxlength="80"/);
    mountOnboarding(root);
    for (let i = 0; i < 2; i++) {
      elements
        .get("onboarding-form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(
      (submissions[0]!.headers as Record<string, string>)["Idempotency-Key"],
      (submissions[1]!.headers as Record<string, string>)["Idempotency-Key"]
    );
    assert.deepEqual(destinations, ["/requirements?project=allowed"]);
    await mountProjectContext(root);
    assert.equal(elements.get("project")!.children.length, 1);
    assert.equal(
      elements.get("project")!.children[0]!.textContent,
      "测试 / <test>"
    );
    assert.equal(elements.get("project")!.value, "allowed");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("first-use idempotency and eligibility survive database reopen across connections", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDatabase } = await import("../packages/database/src/index.js");
  const { securityContext, requestContext } = await import(
    "../packages/security/src/index.js"
  );
  const directory = mkdtempSync(join(tmpdir(), "octo-onboarding-"));
  const url = "file:" + join(directory, "state.sqlite");
  let database = openDatabase(url);
  try {
    database.migrate();
    // Provision only the account, through the same service used by account:create.
    const { randomBytes } = await import("node:crypto");
    await database.accounts.create(
      "synthetic-account",
      "synthetic-user",
      randomBytes(24).toString("base64url")
    );
    let auth = new Authorization(database.identities);
    const token = auth.issueUserSession("synthetic-user");
    const body = { organizationName: "合成组织", projectName: "合成项目" };
    const first = securityContext.run(
      requestContext(undefined, "durable-key"),
      () => database.onboarding(auth).create(token, body)
    );
    database.close();
    database = openDatabase(url);
    auth = new Authorization(database.identities);
    const secondConnection = openDatabase(url);
    try {
      const secondAuth = new Authorization(secondConnection.identities);
      const replay = securityContext.run(
        requestContext(undefined, "durable-key"),
        () => secondConnection.onboarding(secondAuth).create(token, body)
      );
      assert.deepEqual(replay, first);
      assert.throws(
        () => database.onboarding(auth).create(token, body),
        /ALREADY_INITIALIZED/
      );
      assert.equal(database.onboarding(auth).list(token).projects.length, 1);
    } finally {
      secondConnection.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real shell follows authorized projects and pages; forged context and revoked access reveal no editor", async () => {
  const f = fixture();
  try {
    const created = (await f.create()).body.data;
    const project = created.projectId;
    for (const page of ["requirements", "market", "contracts"]) {
      const result = await f.call("/" + page + "?project=" + project);
      assert.equal(result.status, 200);
      assert.match(result.body, /aria-label="主导航"/);
      assert.match(
        result.body,
        new RegExp(`href="/${page}\\?project=${project}" aria-current="page"`)
      );
      assert.match(result.body, /id="project"/);
      assert.doesNotMatch(
        result.body,
        /href="\/workspaces|项目 ID|id="session"/
      );
    }
    assert.match((await f.call("/requirements")).body, /待补全：.*验收标准/);
    assert.equal((await f.call("/workspaces")).status, 403);
    const forged = await f.call("/requirements?project=ungranted");
    assert.equal(forged.status, 403);
    assert.doesNotMatch(forged.body, /id="requirement-form"/);
    f.db
      .prepare(
        "DELETE FROM resource_grants WHERE user_id=? AND resource_id=? AND action='write'"
      )
      .run("new-user", project);
    assert.equal((await f.call("/contracts")).status, 403);
    f.db
      .prepare("DELETE FROM resource_grants WHERE user_id=? AND resource_id=?")
      .run("new-user", project);
    const revoked = await f.call("/requirements");
    assert.equal(revoked.status, 403);
    assert.doesNotMatch(revoked.body, /id="requirement-form"|测试项目/);
    for (const page of ["requirements", "market", "contracts", "workspaces"]) {
      const anonymous = await f.call("/" + page, "GET", undefined, "");
      assert.equal(anonymous.status, 303);
      assert.equal(anonymous.headers.Location, "/login?expired=1");
    }
    assert.match(
      (await f.call("/login?expired=1")).body,
      /登录已失效，请重新登录/
    );
    assert.equal(
      (await f.call("/preview/requirements", "GET", undefined, "")).status,
      200
    );
  } finally {
    f.db.close();
  }
});
