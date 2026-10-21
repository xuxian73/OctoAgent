import { test } from "node:test";
import assert from "node:assert/strict";
import { mountContracts, renderContracts } from "../apps/web/src/contracts.js";
import { mountMarket, renderMarket } from "../apps/web/src/market.js";

class Element extends EventTarget {
  value = "";
  textContent = "";
  checked = false;
  hidden = false;
  href = "";
  children: Element[] = [];
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  click() {
    this.dispatchEvent(new Event("click"));
  }
}
function documentFor(html: string) {
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1]!, new Element()])
  );
  const root = ({
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Element()
  } as unknown) as Document;
  return { root, el: (id: string) => elements.get(id)! };
}
const settle = async () => {
  for (let n = 0; n < 8; n++) await new Promise<void>(r => setImmediate(r));
};

test("orders open the displayed contract and current milestones without typing identifiers", async () => {
  const { root, el } = documentFor(renderContracts());
  const original = globalThis.fetch;
  const contract = {
    id: "synthetic-contract",
    party: "seller",
    status: "active",
    version: 2,
    revision: 4,
    versions: [{ terms: { scope: "合成合同" } }],
    milestones: [
      { id: "old", version: 1, title: "旧范围", status: "planned" },
      { id: "current", version: 2, title: "当前交付", status: "planned" }
    ]
  };
  const paths: string[] = [];
  globalThis.fetch = (async (url: string) => {
    paths.push(url);
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic" } })
      } as Response;
    const data =
      url === "/api/contracts"
        ? [contract]
        : url === "/api/contracts/bids"
        ? [
            {
              id: "offer",
              requirement_id: "task",
              proposal: { summary: "我的方案" },
              status: "submitted"
            }
          ]
        : contract;
    return { ok: true, json: async () => ({ ok: true, data }) } as Response;
  }) as typeof fetch;
  try {
    mountContracts(root);
    await settle();
    el("orders").children[0]!.click();
    await settle();
    assert.ok(paths.includes("/api/contracts/synthetic-contract"));
    assert.equal(el("contract").value, contract.id);
    assert.equal(el("milestone").children.length, 1);
    assert.equal(el("milestone").children[0]!.value, "current");
    assert.equal(
      el("workspace").href,
      "/workspaces?contract=synthetic-contract"
    );
    assert.equal(el("workspace").hidden, false);
    assert.equal(
      el("my-bids").children[0]!.href,
      "/market?task=task&bid=offer"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("comparison selection sends the displayed bid and requires explicit confirmation", async () => {
  const { root, el } = documentFor(renderMarket());
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me")
      return {
        ok: true,
        json: async () => ({ data: { csrf: "synthetic" } })
      } as Response;
    if (url === "/api/contracts/select") {
      bodies.push(JSON.parse(String(init!.body)));
      return {
        ok: false,
        json: async () => ({
          ok: false,
          error: { code: "CONFIRMATION_REQUIRED" }
        })
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        data: [
          {
            id: "selected-offer",
            owner_id: "seller",
            version: 1,
            task_version: 1,
            proposal: { summary: "方案" }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;
  try {
    mountMarket(root);
    el("task").value = "task";
    el("compare").click();
    await settle();
    const children = el("comparison").children;
    const choose = children.at(-1)!;
    assert.equal(choose.textContent, "选择此报价");
    choose.click();
    await settle();
    assert.deepEqual(bodies[0], { bidId: "selected-offer", confirmed: false });
    children.at(-2)!.children[0]!.checked = true;
    choose.click();
    await settle();
    assert.deepEqual(bodies[1], { bidId: "selected-offer", confirmed: true });
  } finally {
    globalThis.fetch = original;
  }
});
