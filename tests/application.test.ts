import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRequest, mountApplication } from "../apps/web/src/client.js";
import { renderApplication } from "../apps/web/src/application.js";
import { renderContracts } from "../apps/web/src/contracts.js";

test("application escapes authorized context and preserves narrow-screen key actions", () => {
  const html = renderApplication(
    renderContracts(),
    "contracts",
    [
      {
        id: "safe",
        organizationId: "org",
        name: "<script>bad</script>",
        pages: ["contracts", "workspaces"]
      }
    ],
    {
      id: "safe",
      organizationId: "org",
      name: "test",
      pages: ["contracts", "workspaces"]
    }
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad|href="\/requirements/);
  assert.match(html, /href="#main"/);
  assert.match(html, /id="milestone-action"/);
  assert.match(html, /id="logout"/);
  assert.match(html, /name="viewport"/);
});

test("shared client carries Cookie/CSRF and retires pending responses and confirmations on project change", async () => {
  class Element extends EventTarget {
    value = "next-project";
    cleared = false;
    replaceChildren() {
      this.cleared = true;
    }
  }
  const project = new Element(),
    main = new Element();
  const root = (Object.assign(new EventTarget(), {
    getElementById: (id: string) => (id === "project" ? project : main)
  }) as unknown) as Document;
  let destination = "",
    calls = 0;
  let finish!: (response: Response) => void;
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, options: RequestInit) => {
    if (path === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      } as Response;
    calls++;
    assert.equal(options.credentials, "same-origin");
    assert.equal(
      (options.headers as Record<string, string>)["X-CSRF-Token"],
      "synthetic-csrf"
    );
    return new Promise<Response>(resolve => {
      finish = resolve;
    });
  }) as typeof fetch;
  try {
    mountApplication(
      root,
      url => {
        destination = url;
      },
      "/contracts"
    );
    const pending = apiRequest("/api/contracts/old");
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    project.dispatchEvent(new Event("change"));
    assert.equal(main.cleared, true);
    assert.equal(destination, "/contracts?project=next-project");
    finish({
      json: async () => ({
        ok: true,
        data: { confirmation: "old-confirmation" }
      })
    } as Response);
    await assert.rejects(pending, /上下文已切换/);
    await assert.rejects(
      apiRequest("/api/contracts/old/commands", "POST", { confirmed: true }),
      /上下文已切换/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
