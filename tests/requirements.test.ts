import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { Authorization, ForbiddenError } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import {
  Requirements,
  MAX_ATTACHMENT_BYTES
} from "../packages/database/src/requirements.js";
import {
  Draft,
  fields,
  contextFields,
  taskTypes,
  budgetTypes,
  parseDraft,
  validate
} from "../packages/requirements/src/model.js";
import { seedIdentities } from "./fixtures/identity.js";
import { requirementRoute } from "../apps/server/src/requirements.js";
import { renderRequirementEditor } from "../apps/web/src/requirements.js";

function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const service = new Requirements(db, auth, () => now);
  const token = auth.issueUserSession("buyer");
  return {
    db,
    auth,
    service,
    token,
    advance: () => {
      now += 600001;
    }
  };
}
function complete(): Draft {
  return {
    publicFields: [],
    values: {
      goal: "演示目标",
      outcome: "离线运行",
      stack: "TypeScript",
      repository: "无",
      environment: "仅测试环境",
      taskType: "新功能",
      budgetType: "固定总价",
      amount: "100.00",
      currency: "CNY",
      timeline: "两周",
      milestones: "阶段一：100",
      deliverables: "代码与文档",
      acceptance: "离线测试通过",
      permissions: "测试环境只读",
      exclusions: "禁止生产操作"
    }
  };
}
function publish(f: ReturnType<typeof fixture>, id: string) {
  return f.service.publish(
    f.token,
    id,
    f.service.preview(f.token, id).confirmation,
    true
  );
}

test("partial drafts persist, missing fields are explicit; every task and budget type round trips", () => {
  const f = fixture();
  try {
    let draft = f.service.create(f.token, "project-a", {
      values: {},
      publicFields: []
    });
    assert.deepEqual(draft.validation.missing, Object.keys(fields));
    assert.throws(
      () => f.service.preview(f.token, draft.id),
      /INCOMPLETE_DRAFT/
    );
    for (const taskType of taskTypes)
      for (const budgetType of budgetTypes) {
        const input = complete();
        input.values.taskType = taskType;
        input.values.budgetType = budgetType;
        draft = f.service.save(f.token, draft.id, draft.revision, input);
        assert.deepEqual(f.service.read(f.token, draft.id).draft, input);
        assert.deepEqual(draft.validation.missing, []);
      }
    assert.throws(
      () =>
        parseDraft({
          ...complete(),
          values: { ...complete().values, currency: "USD" }
        }),
      /UNSUPPORTED_CURRENCY/
    );
    assert.throws(
      () =>
        parseDraft({
          ...complete(),
          values: { ...complete().values, taskType: "未知" }
        }),
      /INVALID_TASK_TYPE/
    );
    assert.throws(
      () =>
        parseDraft({
          ...complete(),
          values: { ...complete().values, budgetType: "未知" }
        }),
      /INVALID_BUDGET_TYPE/
    );
    for (const amount of ["0", "-1", "NaN", "1e2", "1.001"]) {
      const invalid = complete();
      invalid.values.amount = amount;
      assert.deepEqual(validate(invalid).invalid, ["amount"]);
      draft = f.service.save(f.token, draft.id, draft.revision, invalid);
      assert.throws(
        () => f.service.preview(f.token, draft.id),
        /INCOMPLETE_DRAFT/
      );
    }
  } finally {
    f.db.close();
  }
});

test("publication requires human confirmation bound to current revision, actor and expiry; replay cannot increment version", () => {
  const f = fixture();
  try {
    const draft = f.service.create(f.token, "project-a", complete());
    const preview = f.service.preview(f.token, draft.id);
    for (const key of ["scope", "budget", "deliverables", "acceptance"])
      assert.ok(Object.hasOwn(preview.summary, key));
    assert.throws(
      () => f.service.publish(f.token, draft.id, preview.confirmation, false),
      /CONFIRMATION_REQUIRED/
    );
    assert.throws(
      () => f.service.publish(f.token, draft.id, "invalid", true),
      /STALE_CONFIRMATION/
    );
    f.db.exec(
      "INSERT INTO users VALUES ('buyer-two', 'member'); INSERT INTO memberships VALUES ('buyer-two', 'org-a', '', 'buyer'), ('buyer-two', 'org-a', 'project-a', 'buyer'); INSERT INTO resource_grants VALUES ('buyer-two', 'project', 'project-a', 'write'), ('buyer-two', 'project', 'project-a', 'read');"
    );
    const other = f.auth.issueUserSession("buyer-two");
    assert.throws(
      () => f.service.publish(other, draft.id, preview.confirmation, true),
      /STALE_CONFIRMATION/
    );
    f.service.save(f.token, draft.id, draft.revision, complete());
    assert.throws(
      () => f.service.publish(f.token, draft.id, preview.confirmation, true),
      /STALE_CONFIRMATION/
    );
    const expired = f.service.preview(f.token, draft.id);
    f.advance();
    assert.throws(
      () => f.service.publish(f.token, draft.id, expired.confirmation, true),
      /STALE_CONFIRMATION/
    );
    const final = f.service.preview(f.token, draft.id);
    assert.equal(
      f.service.publish(f.token, draft.id, final.confirmation, true).version,
      1
    );
    assert.throws(
      () => f.service.publish(f.token, draft.id, final.confirmation, true),
      /STALE_CONFIRMATION/
    );
    assert.equal(f.service.read(f.token, draft.id).version, 1);
    f.db.exec(
      "INSERT INTO agents VALUES ('buyer-agent', 'buyer', 'buyer', '[]')"
    );
    const agent = f.auth.issueAgentToken(f.token, "buyer-agent", [
      { kind: "project", resourceId: "project-a", action: "write" },
      { kind: "project", resourceId: "project-a", action: "read" }
    ]);
    assert.throws(() => f.service.preview(agent, draft.id), ForbiddenError);
    assert.throws(
      () => f.service.publish(agent, draft.id, final.confirmation, true),
      ForbiddenError
    );
  } finally {
    f.db.close();
  }
});

test("independent connections reject stale edits; versions, change keys and bidder events commit atomically and persist", () => {
  const directory = mkdtempSync(join(tmpdir(), "octo-requirement-"));
  const path = join(directory, "db.sqlite");
  const f = fixture(path);
  const second = new DatabaseSync(path);
  const service = new Requirements(
    second,
    new Authorization(new SqliteIdentityStore(second), () => 1000),
    () => 1000
  );
  try {
    const draft = f.service.create(f.token, "project-a", complete());
    const first = publish(f, draft.id);
    f.db
      .prepare("INSERT INTO requirement_participants VALUES (?, ?)")
      .run(draft.id, "seller");
    const edited = complete();
    edited.values.goal = "修改后的合成目标";
    edited.publicFields = ["goal"];
    const saved = f.service.save(f.token, draft.id, first.revision, edited);
    assert.throws(
      () => service.save(f.token, draft.id, first.revision, complete()),
      /REVISION_CONFLICT/
    );
    assert.equal(service.read(f.token, draft.id).revision, saved.revision);
    assert.deepEqual(f.service.publicView(draft.id).values, {});
    const preview = f.service.preview(f.token, draft.id);
    f.db.exec(
      "CREATE TRIGGER reject_notification BEFORE INSERT ON requirement_notifications BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;"
    );
    assert.throws(
      () => f.service.publish(f.token, draft.id, preview.confirmation, true),
      /simulated failure/
    );
    assert.equal(f.service.read(f.token, draft.id).version, 1);
    assert.equal(f.service.read(f.token, draft.id).changes.length, 1);
    f.db.exec("DROP TRIGGER reject_notification");
    const published = f.service.publish(
      f.token,
      draft.id,
      preview.confirmation,
      true
    );
    assert.equal(published.version, 2);
    assert.deepEqual(JSON.parse(String(published.changes[1]!.changed_fields)), [
      "goal",
      "publicFields"
    ]);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM requirement_notifications").get()!
        .n,
      1
    );
    assert.equal(
      f.db.prepare("SELECT user_id FROM requirement_notifications").get()!
        .user_id,
      "seller"
    );
    assert.equal(service.publicView(draft.id).values.goal, edited.values.goal);
    assert.throws(
      () => service.publish(f.token, draft.id, preview.confirmation, true),
      /STALE_CONFIRMATION/
    );
  } finally {
    second.close();
    f.db.close();
  }
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(
      reopened.prepare("SELECT version FROM requirements").get()!.version,
      2
    );
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("drafts and private metadata require buyer project grants, even for same-org sellers and platform admins", () => {
  const f = fixture();
  try {
    const draft = f.service.create(f.token, "project-a", complete());
    const attachment = f.service.addAttachment(f.token, draft.id, {
      revision: draft.revision,
      name: "synthetic.txt",
      mime: "text/plain",
      size: 12
    });
    for (const user of ["outsider", "seller", "admin"]) {
      const token = f.auth.issueUserSession(user);
      for (const id of [draft.id, "missing"]) {
        assert.throws(() => f.service.read(token, id), ForbiddenError);
        assert.throws(
          () => f.service.attachment(token, id, attachment.id),
          ForbiddenError
        );
        assert.throws(
          () => f.service.addAttachment(token, id, {}),
          ForbiddenError
        );
        assert.throws(
          () => f.service.save(token, id, 1, complete()),
          ForbiddenError
        );
      }
      assert.throws(
        () => f.service.create(token, "project-a", complete()),
        ForbiddenError
      );
    }
    assert.equal(
      f.service.attachment(f.token, draft.id, attachment.id).private,
      1
    );
    assert.throws(() => f.service.publicView(draft.id), /NOT_FOUND/);
    publish(f, draft.id);
    assert.deepEqual(f.service.publicView(draft.id).values, {});
    assert.deepEqual(f.service.publicView(draft.id).attachments, []);
    f.db.exec(
      "DELETE FROM resource_grants WHERE user_id = 'buyer' AND action = 'read'"
    );
    assert.throws(
      () => f.service.attachment(f.token, draft.id, attachment.id),
      ForbiddenError
    );
    const revision = f.db
      .prepare("SELECT revision FROM requirements WHERE id = ?")
      .get(draft.id)!.revision;
    assert.throws(
      () => f.service.save(f.token, draft.id, Number(revision), complete()),
      ForbiddenError
    );
    assert.equal(
      f.db
        .prepare("SELECT revision FROM requirements WHERE id = ?")
        .get(draft.id)!.revision,
      revision
    );
  } finally {
    f.db.close();
  }
});

test("attachment validation is server-side and new public metadata waits for a fresh publication", () => {
  const f = fixture();
  try {
    const draft = f.service.create(f.token, "project-a", complete());
    const valid = {
      revision: draft.revision,
      name: "synthetic.txt",
      mime: "text/plain",
      size: 12
    };
    for (const invalid of [
      { ...valid, size: MAX_ATTACHMENT_BYTES + 1 },
      { ...valid, size: 0 },
      { ...valid, size: 1.5 },
      { ...valid, mime: "application/javascript" },
      { ...valid, name: "../synthetic.txt" },
      { ...valid, name: "synthetic.exe" },
      { ...valid, private: "false" }
    ])
      assert.throws(
        () => f.service.addAttachment(f.token, draft.id, invalid),
        /INVALID_ATTACHMENT/
      );
    for (const revision of [undefined, "1", 1.5]) {
      const rejected = { ...valid, revision };
      assert.throws(
        () => f.service.addAttachment(f.token, draft.id, rejected),
        /REVISION_REQUIRED/
      );
    }
    const preview = f.service.preview(f.token, draft.id);
    const added = f.service.addAttachment(f.token, draft.id, {
      ...valid,
      size: MAX_ATTACHMENT_BYTES,
      private: false
    });
    assert.equal(added.revision, draft.revision + 1);
    assert.equal(added.attachments.length, 1);
    assert.throws(
      () => f.service.addAttachment(f.token, draft.id, valid),
      /REVISION_CONFLICT/
    );
    assert.equal(f.service.read(f.token, draft.id).revision, added.revision);
    assert.equal(f.service.read(f.token, draft.id).attachments.length, 1);
    assert.throws(
      () => f.service.publish(f.token, draft.id, preview.confirmation, true),
      /STALE_CONFIRMATION/
    );
    publish(f, draft.id);
    assert.equal(f.service.publicView(draft.id).attachments.length, 1);
    f.service.addAttachment(f.token, draft.id, {
      ...valid,
      revision: f.service.read(f.token, draft.id).revision,
      private: false
    });
    assert.equal(f.service.publicView(draft.id).attachments.length, 1);
    publish(f, draft.id);
    assert.equal(f.service.publicView(draft.id).attachments.length, 2);
  } finally {
    f.db.close();
  }
});

async function request(
  service: Requirements,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  contentType = "application/json"
) {
  const stream = Readable.from(
    body === undefined
      ? []
      : [typeof body === "string" ? body : JSON.stringify(body)]
  ) as IncomingMessage;
  stream.url = "/api/requirements" + path;
  stream.method = method;
  stream.headers = { "content-type": contentType };
  stream.rawHeaders = token ? ["Authorization", "Bearer " + token] : [];
  let output = "";
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => headers.set(name, value),
    end: (value: string) => {
      output = value;
    }
  };
  await requirementRoute(
    stream,
    (response as unknown) as ServerResponse,
    "synthetic-request",
    service
  );
  return {
    status: response.statusCode,
    body: JSON.parse(output),
    headers,
    output
  };
}

test("offline HTTP lifecycle validates bodies, returns generic errors and never echoes rejected input", async () => {
  const f = fixture();
  try {
    const created = await request(f.service, f.token, "", "POST", {
      projectId: "project-a",
      draft: complete()
    });
    assert.equal(created.status, 200);
    const id = created.body.data.id;
    assert.equal(created.headers.get("Cache-Control"), "no-store");
    assert.equal((await request(f.service, "", "/" + id)).status, 403);
    assert.equal(
      (
        await request(f.service, f.token, "/" + id, "PUT", {
          revision: 1,
          draft: complete()
        })
      ).status,
      200
    );
    assert.equal(
      (
        await request(f.service, f.token, "/" + id, "PUT", {
          revision: 1,
          draft: complete()
        })
      ).status,
      409
    );
    const preview = await request(
      f.service,
      f.token,
      "/" + id + "/preview",
      "POST",
      {}
    );
    assert.equal(
      (
        await request(f.service, f.token, "/" + id + "/publish", "POST", {
          confirmation: preview.body.data.confirmation,
          confirmed: false
        })
      ).status,
      400
    );
    assert.equal(
      (
        await request(f.service, f.token, "/" + id + "/publish", "POST", {
          confirmation: preview.body.data.confirmation,
          confirmed: true
        })
      ).body.data.version,
      1
    );
    assert.deepEqual(
      (await request(f.service, "", "/" + id + "/public")).body.data.values,
      {}
    );
    for (const body of ["{", "null", "[]", '"synthetic-rejected-input"']) {
      const rejected = await request(f.service, f.token, "", "POST", body);
      assert.equal(rejected.status, 400);
      assert.doesNotMatch(rejected.output, /synthetic-rejected-input/);
    }
    assert.equal(
      (await request(f.service, f.token, "", "POST", {}, "text/plain")).status,
      415
    );
    assert.equal(
      (await request(f.service, f.token, "", "POST", "x".repeat(200001)))
        .status,
      413
    );
    assert.equal(
      (
        await request(f.service, f.token, "/" + id + "/attachments", "POST", {
          name: "synthetic.exe",
          mime: "application/octet-stream",
          size: 1
        })
      ).status,
      400
    );
  } finally {
    f.db.close();
  }
});

test("editor exposes all structured fields, private defaults, summary confirmation and reload controls", () => {
  const html = renderRequirementEditor();
  for (const field of Object.keys(fields))
    assert.ok(html.includes(`name="${field}"`));
  for (const label of [
    ...taskTypes,
    ...budgetTypes,
    "保存草稿",
    "加载草稿",
    "范围、预算、交付物、验收标准"
  ])
    assert.ok(html.includes(label));
  assert.match(html, /id="confirmation" hidden/);
  assert.doesNotMatch(html, / checked/);
  assert.doesNotMatch(html, /项目 ID/);
  assert.doesNotMatch(html, /id="session"/);
  assert.match(html, /aria-live="polite"/);
});

test("editor saves, reloads and publishes through HTTP; editing invalidates visible confirmation", async () => {
  const { mountRequirementEditor } = await import(
    "../apps/web/src/requirements.js"
  );
  class Element extends EventTarget {
    value = "";
    checked = false;
    hidden = false;
    textContent = "";
    files: { name: string; type: string; size: number }[] = [];
    dataset: { public?: string } = {};
    children: Element[] = [];
    append(...elements: Element[]) {
      this.children.push(...elements);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const elements = new Map<string, Element>();
  for (const id of [
    ...Object.keys(fields),
    "requirement-form",
    "session",
    "project",
    "draft-id",
    "status",
    "confirmation",
    "confirmed",
    "load",
    "preview-summary",
    "summary",
    "publish",
    "add-attachment",
    "attachment",
    "attachment-public",
    "attachments",
    "changes",
    "market-enabled",
    "market-deadline",
    "market-days",
    "market-risk",
    "market-agents"
  ])
    elements.set(id, new Element());
  const publicBoxes = Object.keys(fields).map(key => {
    const el = new Element();
    el.dataset.public = key;
    return el;
  });
  const root = ({
    querySelector: () => elements.get("requirement-form"),
    getElementById: (id: string) => elements.get(id),
    querySelectorAll: () => publicBoxes,
    createElement: () => new Element()
  } as unknown) as Document;
  const f = fixture();
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  let attachmentResponse: Promise<void> | undefined;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      } as Response;
    requests.push(url);
    const result = await request(
      f.service,
      elements.get("session")!.value,
      url.replace("/api/requirements", ""),
      options.method,
      options.body ? String(options.body) : undefined
    );
    if (url.endsWith("/attachments")) await attachmentResponse;
    return { json: async () => result.body } as Response;
  }) as typeof fetch;
  async function dispatch(id: string, event = "click") {
    elements.get(id)!.dispatchEvent(new Event(event, { cancelable: true }));
    // Drain the mocked streams and chained save/preview requests without wall-clock sleeps.
    for (let i = 0; i < 5; i++)
      await new Promise<void>(resolve => setImmediate(resolve));
  }
  try {
    elements.get("session")!.value = f.token;
    elements.get("project")!.value = "project-a";
    mountRequirementEditor(root);
    await dispatch("requirement-form", "submit");
    assert.match(elements.get("status")!.textContent, /目标与背景/);
    const id = elements.get("draft-id")!.value;
    assert.ok(id);
    for (const [key, value] of Object.entries(complete().values))
      elements.get(key)!.value = value;
    await dispatch("preview-summary");
    assert.equal(elements.get("confirmation")!.hidden, false);
    assert.equal(elements.get("summary")!.children.length, 10);
    await dispatch("publish");
    assert.equal(f.service.read(f.token, id).version, 0);
    elements.get("confirmed")!.checked = true;
    await dispatch("requirement-form", "input");
    assert.equal(elements.get("confirmation")!.hidden, true);
    assert.equal(elements.get("confirmed")!.checked, false);
    await dispatch("preview-summary");
    elements.get("confirmed")!.checked = true;
    await dispatch("publish");
    assert.equal(f.service.read(f.token, id).version, 1);
    elements.get("goal")!.value = "未保存的合成编辑";
    await dispatch("load");
    assert.equal(elements.get("goal")!.value, complete().values.goal);
    assert.equal(elements.get("changes")!.children.length, 1);
    // Preserve every field and both directions of public-flag edits, including
    // edits made while the attachment request is still pending.
    publicBoxes.find(
      box => box.dataset.public === "repository"
    )!.checked = true;
    await dispatch("requirement-form", "submit");
    for (const initialState of ["saved", "loaded"]) {
      if (initialState === "loaded") await dispatch("load");
      const before = f.service.read(f.token, id);
      for (const key of Object.keys(fields))
        elements.get(key)!.value = `待保存-${key}`;
      elements.get("market-enabled")!.checked = true;
      elements.get("market-deadline")!.value = "2030-01-01T12:00";
      elements.get("market-days")!.value = "14";
      elements.get("market-risk")!.value = "high";
      elements.get("market-agents")!.checked = true;
      publicBoxes.forEach(
        box =>
          (box.checked =
            contextFields.some(key => key === box.dataset.public) ||
            !box.checked)
      );
      const expectedPublic = publicBoxes
        .filter(box => box.checked)
        .map(box => box.dataset.public);
      elements.get("attachment")!.files = [
        { name: "example.txt", type: "text/plain", size: 12 }
      ];
      let release!: () => void;
      attachmentResponse = new Promise<void>(resolve => {
        release = resolve;
      });
      await dispatch("add-attachment");
      elements.get("goal")!.value = "请求期间继续编辑";
      elements.get("market-days")!.value = "21";
      release();
      for (let i = 0; i < 5; i++)
        await new Promise<void>(resolve => setImmediate(resolve));
      for (const key of Object.keys(fields))
        assert.equal(
          elements.get(key)!.value,
          key === "goal" ? "请求期间继续编辑" : `待保存-${key}`
        );
      assert.deepEqual(
        publicBoxes.filter(box => box.checked).map(box => box.dataset.public),
        expectedPublic
      );
      assert.equal(elements.get("market-enabled")!.checked, true);
      assert.equal(elements.get("market-deadline")!.value, "2030-01-01T12:00");
      assert.equal(elements.get("market-days")!.value, "21");
      assert.equal(elements.get("market-risk")!.value, "high");
      assert.equal(elements.get("market-agents")!.checked, true);
      assert.deepEqual(f.service.read(f.token, id).draft, before.draft);
      assert.equal(
        elements.get("attachments")!.children.length,
        initialState === "saved" ? 1 : 2
      );
      assert.equal(elements.get("confirmation")!.hidden, true);
      assert.match(elements.get("status")!.textContent, /请保存草稿/);
      // A subsequent save uses the refreshed revision and persists retained edits.
      for (const [key, value] of Object.entries(complete().values))
        if (key !== "goal") elements.get(key)!.value = value;
      await dispatch("requirement-form", "submit");
      const saved = f.service.read(f.token, id);
      assert.equal(saved.revision, before.revision + 2);
      assert.equal(saved.draft.values.goal, "请求期间继续编辑");
      assert.deepEqual(saved.draft.market, {
        deadline: new Date("2030-01-01T12:00").getTime(),
        durationDays: 21,
        risk: "high",
        allowAgents: true
      });
      assert.deepEqual(saved.draft.publicFields, expectedPublic);
    }
    // A second session changes both budget and visibility before attachment
    // submission, or after commit while the first session awaits the response.
    const secondToken = f.auth.issueUserSession("buyer");
    for (const timing of ["before", "after-commit"]) {
      await dispatch("load");
      const before = f.service.read(f.token, id);
      elements.get("market-enabled")!.checked = false;
      elements.get("amount")!.value = "150.00";
      publicBoxes.forEach(box => (box.checked = box.dataset.public === "goal"));
      const remote = complete();
      remote.values.amount = "250.00";
      remote.publicFields = ["amount"];
      let release!: () => void;
      attachmentResponse = new Promise<void>(resolve => {
        release = resolve;
      });
      if (timing === "after-commit") await dispatch("add-attachment");
      const current = f.service.read(secondToken, id);
      const remoteSave = await request(
        f.service,
        secondToken,
        "/" + id,
        "PUT",
        {
          revision: current.revision,
          draft: remote
        }
      );
      assert.equal(remoteSave.status, 200);
      const requestStart = requests.length;
      if (timing === "before") await dispatch("add-attachment");
      release();
      for (let i = 0; i < 5; i++)
        await new Promise<void>(resolve => setImmediate(resolve));
      // No follow-up GET may adopt the other session's revision.
      assert.ok(
        requests.slice(requestStart).every(url => url.endsWith("/attachments"))
      );
      if (timing === "before")
        assert.match(
          elements.get("status")!.textContent,
          /版本冲突.*本地编辑已保留/
        );
      assert.equal(elements.get("amount")!.value, "150.00");
      assert.deepEqual(
        publicBoxes.filter(box => box.checked).map(box => box.dataset.public),
        ["goal"]
      );
      await dispatch("requirement-form", "submit");
      assert.match(
        elements.get("status")!.textContent,
        /版本冲突.*本地编辑已保留/
      );
      assert.equal(elements.get("amount")!.value, "150.00");
      assert.deepEqual(
        publicBoxes.filter(box => box.checked).map(box => box.dataset.public),
        ["goal"]
      );
      const persisted = f.service.read(f.token, id);
      assert.deepEqual(persisted.draft, remote);
      assert.equal(persisted.revision, remoteSave.body.data.revision);
      assert.equal(
        persisted.attachments.length,
        before.attachments.length + (timing === "before" ? 0 : 1)
      );
    }
    assert.ok(requests.every(url => !url.includes(f.token)));
  } finally {
    globalThis.fetch = previousFetch;
    f.db.close();
  }
});
