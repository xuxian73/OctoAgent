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
