import { test } from "node:test";
import assert from "node:assert/strict";
import { mountZipReview, renderZipReview } from "../apps/web/src/zip-review.js";
import { renderWorkspaces } from "../apps/web/src/workspaces.js";
import { setup } from "./fixtures/contracts.js";
import { stageZip } from "./fixtures/delivery.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { Files } from "../packages/database/src/files.js";
class Element extends EventTarget {
  value = "";
  textContent = "";
  checked = false;
  hidden = false;
  href = "";
  children: Element[] = [];
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
    this.textContent = "";
  }
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r));
};
test("ZIP web reviews bind displayed immutable version; stale page rejected; rework history and completion", async () => {
  const f = setup();
  f.activate();
  const id = f.current().id,
    milestone = String(f.current().milestones[0]!.id);
  const work = new Workspaces(f.db, f.auth, () => 1000);
  const elements = new Map(
    [...renderZipReview().matchAll(/id="([^"]+)"/g)].map(m => [
      m[1]!,
      new Element()
    ])
  );
  const el = (id: string) => elements.get(id)!;
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Element()
  } as unknown) as Document;
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic" } })
      } as Response;
    try {
      let data;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        data = f.contracts.command(f.buyer, id, body);
      } else if (url.startsWith("/api/files"))
        data = new Files(f.db, f.auth).list(f.buyer, "artifact", id);
      else data = f.contracts.read(f.buyer, id);
      return { ok: true, json: async () => ({ ok: true, data }) } as Response;
    } catch (e) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: { code: String(e) } })
      } as Response;
    }
  }) as typeof fetch;
  const submit = async (m: string) =>
    work.command(f.seller, id, {
      action: "submit_milestone",
      version: 1,
      milestoneId: m,
      requestKey: crypto.randomUUID(),
      ...(await stageZip(f, id, m))
    });
  try {
    await submit(milestone);
    let selected = milestone;
    const panel = mountZipReview(
      root,
      () => id,
      () => selected
    );
    await panel.refresh();
    assert.equal(el("zip-review-form").hidden, false);
    const first = f.contracts.read(f.buyer, id).zipDeliveries[0]!;
    assert.match(el("zip-target").textContent, /第 1 版/);
    const link = el("zip-history").children[0]!.children.find(e => e.href)!;
    assert.equal(link.href, `/api/files/${first.file_id}/download`);
    el("zip-decision").value = "changes_requested";
    el("zip-reason").value = "请修改文档";
    el("zip-confirm").checked = true;
    el("zip-review-form").dispatchEvent(new Event("submit"));
    await settle();
    assert.equal(bodies[0].deliveryId, first.id);
    assert.equal(
      f.contracts.read(f.buyer, id).milestones[0]!.status,
      "changes_requested"
    );
    assert.ok(
      el("zip-history").children[0]!.children.some(e =>
        e.textContent.includes("请修改文档")
      )
    );
    await submit(milestone);
    // The old snapshot must not silently accept the newly submitted bytes.
    el("zip-decision").value = "accepted";
    el("zip-confirm").checked = true;
    el("zip-review-form").dispatchEvent(new Event("submit"));
    await settle();
    assert.equal(
      f.contracts.read(f.buyer, id).milestones[0]!.status,
      "submitted"
    );
    assert.match(el("zip-review-status").textContent, /操作未完成/);
    await panel.refresh();
    assert.equal(el("zip-review-status").textContent, "");
    assert.equal(el("zip-history").children.length, 2);
    assert.match(el("zip-target").textContent, /第 2 版/);
    el("zip-confirm").checked = true;
    el("zip-review-form").dispatchEvent(new Event("submit"));
    await settle();
    assert.equal(
      f.contracts.read(f.buyer, id).milestones[0]!.status,
      "accepted"
    );
    assert.equal(f.contracts.read(f.buyer, id).settlement, "unsettled");
    selected = String(f.current().milestones[1]!.id);
    await submit(selected);
    await panel.refresh();
    el("zip-confirm").checked = true;
    el("zip-review-form").dispatchEvent(new Event("submit"));
    await settle();
    assert.equal(el("zip-complete").hidden, false);
    el("zip-complete").dispatchEvent(new Event("click"));
    await settle();
    assert.equal(f.contracts.read(f.buyer, id).status, "completed");
    assert.equal(f.contracts.read(f.buyer, id).settlement, "unsettled");
    panel.clear();
    assert.equal(el("zip-review-form").hidden, true);
    assert.equal(el("zip-history").children.length, 0);
  } finally {
    globalThis.fetch = original;
    f.db.close();
  }
});
test("ZIP main flow hides Git controls and has labeled manual review", () => {
  assert.match(renderWorkspaces(), /id="git-extension" hidden/);
  assert.doesNotMatch(
    renderWorkspaces(),
    /option value="(?:branch|commit|check|pull_request)"/
  );
  assert.match(renderWorkspaces(), /aria-label="文件传输进度"/);
  assert.match(renderZipReview(), /id="zip-confirm" type="checkbox" required/);
});

test("workspace uploads same-name same-byte rework and refreshes milestones through bubbling input", async () => {
  const { mountWorkspaces } = await import("../apps/web/src/workspaces.js");
  const { controlledScanner } = await import("./fixtures/delivery.js");
  const { zip } = await import("./fixtures/zip.js");
  const f = setup();
  f.activate();
  const id = f.current().id;
  const milestones = f.current().milestones.map(m => String(m.id));
  const work = new Workspaces(f.db, f.auth);
  const files = new Files(f.db, f.auth, controlledScanner);
  for (const permission of ["artifact", "submit"])
    work.command(f.buyer, id, {
      action: "authorize",
      version: 1,
      requestKey: crypto.randomUUID(),
      actorId: f.auth.identity(f.seller).id,
      permission,
      ttlMs: 900000,
      confirmed: true
    });
  const documentEvents = new EventTarget();
  class Control extends Element {
    id = "";
    tag = "";
    files: File[] = [];
    onclick?: () => void;
    append(...nodes: Element[]) {
      super.append(...nodes);
      if (this.tag === "select" && !this.value)
        this.value = nodes[0]?.value || "";
    }
    replaceChildren() {
      super.replaceChildren();
      this.value = "";
    }
    click() {
      this.dispatchEvent(new Event("click"));
    }
    dispatchEvent(event: Event) {
      const result = super.dispatchEvent(event);
      if (event.type === "click") this.onclick?.();
      if (event.bubbles) {
        // Preserve the target while propagating to the document, as in the DOM.
        Object.defineProperty(event, "target", { value: this });
        documentEvents.dispatchEvent(event);
      }
      return result;
    }
  }
  const elements = new Map(
    [...renderWorkspaces().matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(m => {
      const element = new Control();
      element.id = m[2]!;
      element.tag = m[1]!;
      return [element.id, element] as const;
    })
  );
  const el = (id: string) => elements.get(id)!;
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Control(),
    addEventListener: documentEvents.addEventListener.bind(documentEvents)
  } as unknown) as Document;
  const originalFetch = globalThis.fetch;
  const originalXHR = globalThis.XMLHttpRequest;
  let actor = f.seller;
  const errors: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    try {
      let data;
      if (url === "/api/auth/me") data = { csrf: "synthetic" };
      else if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        data = url.includes("/workspaces/")
          ? work.command(actor, id, body)
          : f.contracts.command(actor, id, body);
      } else if (url === "/api/contracts") data = [f.contracts.read(actor, id)];
      else if (url.startsWith("/api/files"))
        data = files.list(actor, "artifact", id);
      else if (url.startsWith("/api/workspaces")) data = work.read(actor, id);
      else data = f.contracts.read(actor, id);
      return { ok: true, json: async () => ({ ok: true, data }) } as Response;
    } catch (e) {
      errors.push(String(e));
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: String(e) } })
      } as Response;
    }
  }) as typeof fetch;
  class Upload {
    upload = {};
    status = 201;
    metadata = "";
    onload = () => {};
    open() {}
    setRequestHeader(key: string, value: string) {
      if (key === "X-File-Metadata") this.metadata = value;
    }
    send(file: File) {
      void file.arrayBuffer().then(async bytes => {
        const saved = files.upload(
          actor,
          JSON.parse(decodeURIComponent(this.metadata)),
          new Uint8Array(bytes)
        );
        await files.scan(String(saved.id));
        this.onload();
      });
    }
  }
  globalThis.XMLHttpRequest = (Upload as unknown) as typeof XMLHttpRequest;
  const upload = async () => {
    el("private-file").files = [
      new File([new Uint8Array(zip("same bytes"))], "delivery.zip")
    ];
    el("file-upload").click();
    await settle();
    el("zip-refresh").click();
    await settle();
  };
  const submit = async (summary: string) => {
    el("zip-summary").value = summary;
    el("zip-instructions").value = "阅读 README";
    el("zip-issues").value = "无";
    el("zip-form").dispatchEvent(new Event("submit", { bubbles: true }));
    await settle();
  };
  try {
    mountWorkspaces(root);
    await settle();
    assert.equal(el("contract").value, id, JSON.stringify(errors));
    await upload();
    const firstFile = el("zip-file").value;
    assert.ok(firstFile);
    assert.match(el("zip-file").children[0]!.textContent, /扫描时间.*SHA-256/);
    await submit("第一版说明");
    assert.equal(el("zip-file").children.length, 0);
    actor = f.buyer;
    el("load").click();
    await settle();
    el("zip-decision").value = "changes_requested";
    el("zip-reason").value = "补充说明";
    el("zip-confirm").checked = true;
    el("zip-review-form").dispatchEvent(new Event("submit", { bubbles: true }));
    await settle();
    actor = f.seller;
    el("load").click();
    await settle();
    await upload();
    assert.equal(el("zip-file").children.length, 1);
    const secondFile = el("zip-file").value;
    assert.notEqual(secondFile, firstFile);
    await submit("补充后的说明");
    const history = f.contracts.read(actor, id).zipDeliveries;
    assert.equal(history.length, 2);
    assert.equal(history[0]!.checksum, history[1]!.checksum);
    assert.equal(history[1]!.file_id, secondFile);
    assert.equal(history[1]!.summary, "补充后的说明");
    el("file-milestone").value = milestones[1]!;
    el("file-milestone").dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await upload();
    const otherFile = el("zip-file").value;
    el("file-milestone").value = milestones[0]!;
    el("file-milestone").dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    assert.equal(el("file-list").children.length, 2);
    assert.equal(el("zip-file").children.length, 0);
    el("file-milestone").value = milestones[1]!;
    el("file-milestone").dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    assert.equal(el("file-list").children.length, 1);
    assert.equal(el("zip-file").value, otherFile);
    await submit("第二里程碑");
    actor = f.buyer;
    el("load").click();
    await settle();
    for (const milestone of milestones) {
      el("file-milestone").value = milestone;
      el("file-milestone").dispatchEvent(new Event("input"));
      await settle();
      el("zip-decision").value = "accepted";
      el("zip-reason").value = "已核对文件";
      el("zip-confirm").checked = true;
      el("zip-review-form").dispatchEvent(new Event("submit"));
      await settle();
      assert.equal(el("file-milestone").value, milestone);
    }
    assert.equal(el("zip-complete").hidden, false);
    el("zip-complete").click();
    el("zip-complete").click();
    await settle();
    assert.match(el("status").textContent, /已完成/);
    assert.match(el("contract").children[0]!.textContent, /completed/);
    assert.match(el("zip-review-status").textContent, /合同已完成/);
    for (const id of [
      "zip-complete",
      "zip-form",
      "file-upload",
      "authorization"
    ])
      assert.equal(el(id).hidden, true, id);
    el("zip-complete").click();
    await settle();
    assert.match(el("zip-review-status").textContent, /合同已完成/);
    el("load").click();
    assert.equal(el("zip-complete").hidden, true);
    await settle();
    assert.equal(el("zip-review-status").textContent, "");
    assert.match(el("status").textContent, /已完成/);
    assert.deepEqual(errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXHR;
    f.db.close();
  }
});

test("ZIP completion response cannot refresh or report success on a different contract", async () => {
  const elements = new Map(
    [...renderZipReview().matchAll(/id="([^"]+)"/g)].map(m => [
      m[1]!,
      new Element()
    ])
  );
  const el = (id: string) => elements.get(id)!;
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Element()
  } as unknown) as Document;
  const original = globalThis.fetch;
  let selected = "first";
  let refreshes = 0;
  let finish: () => void = () => {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      await new Promise<void>(resolve => {
        finish = resolve;
      });
    const data =
      url === "/api/auth/me"
        ? { csrf: "synthetic" }
        : url.startsWith("/api/files")
        ? []
        : {
            id: selected,
            status: "active",
            version: 1,
            revision: 1,
            milestones: [{ id: "m", version: 1, status: "accepted" }],
            zipDeliveries: [],
            events: []
          };
    return { ok: true, json: async () => ({ ok: true, data }) } as Response;
  }) as typeof fetch;
  try {
    const panel = mountZipReview(
      root,
      () => selected,
      () => "m",
      () => "buyer",
      async () => {
        refreshes++;
      }
    );
    await panel.refresh();
    assert.equal(el("zip-complete").hidden, false);
    el("zip-complete").dispatchEvent(new Event("click"));
    await settle();
    selected = "second";
    panel.clear();
    assert.equal(el("zip-complete").hidden, true);
    finish();
    await settle();
    assert.equal(refreshes, 0);
    assert.equal(el("zip-review-status").textContent, "");
    assert.equal(el("zip-complete").hidden, true);
  } finally {
    globalThis.fetch = original;
  }
});
