import { test } from "node:test";
import assert from "node:assert/strict";
import { mountNotifications } from "../apps/web/src/client.js";
import {
  renderApplication,
  emptyApplication
} from "../apps/web/src/application.js";

test("signed-in notification panel loads versions, authorized links, pages and persisted read state", async () => {
  class Element extends EventTarget {
    textContent = "";
    href = "";
    hidden = false;
    disabled = false;
    children: Element[] = [];
    append(...items: Element[]) {
      this.children.push(...items);
    }
    replaceChildren() {
      this.children = [];
    }
  }
  const nodes = Object.fromEntries(
    [
      "notification-items",
      "notification-next",
      "notification-refresh"
    ].map(id => [id, new Element()])
  );
  const root = ({
    getElementById: (id: string) => nodes[id],
    createElement: () => new Element()
  } as unknown) as Document;
  const original = globalThis.fetch;
  let read = false;
  const paths: string[] = [];
  globalThis.fetch = (async (path: string, options?: RequestInit) => {
    if (path === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic-csrf" } })
      } as Response;
    paths.push(path);
    if (options?.method === "POST") read = true;
    return {
      json: async () => ({
        ok: true,
        data:
          options?.method === "POST"
            ? { readAt: 1000 }
            : {
                items: [
                  {
                    requirementId: "task",
                    version: path.endsWith("=1") ? 3 : 2,
                    href: "/market?project=project-a&task=task",
                    readAt: read ? 1000 : null
                  }
                ],
                nextCursor: path.endsWith("=1") ? null : 1
              }
      })
    } as Response;
  }) as typeof fetch;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    assert.match(
      renderApplication(emptyApplication("测试"), "market", []),
      /id="notifications"/
    );
    mountNotifications(root);
    await settle();
    const row = nodes["notification-items"]!.children[0]!;
    assert.match(row.children[0]!.textContent, /需求已变更 · 版本 2/);
    assert.equal(row.children[0]!.href, "/market?project=project-a&task=task");
    row.children[1]!.dispatchEvent(new Event("click"));
    await settle();
    assert.ok(paths.includes("/api/market/notifications/task/2/read"));
    assert.equal(
      nodes["notification-items"]!.children[0]!.children[1]!.textContent,
      "已读"
    );
    nodes["notification-next"]!.dispatchEvent(new Event("click"));
    await settle();
    assert.match(
      nodes["notification-items"]!.children[0]!.children[0]!.textContent,
      /版本 3/
    );
    assert.equal(nodes["notification-next"]!.hidden, true);
  } finally {
    globalThis.fetch = original;
  }
});
