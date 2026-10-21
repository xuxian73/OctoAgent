import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionHeaders } from "../apps/web/src/session.js";

test("expired session clears current document before redirect and never returns credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document"
  );
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location"
  );
  const events: string[] = [];
  const root = new EventTarget();
  root.addEventListener("session-ended", () => events.push("clear"));
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: root
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { assign: (url: string) => events.push(url) }
  });
  globalThis.fetch = (async () =>
    new Response(null, { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(sessionHeaders(), /登录已失效/);
    assert.deepEqual(events, ["clear", "/login?expired=1"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of [
      ["document", originalDocument],
      ["location", originalLocation]
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
