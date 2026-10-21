import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  renderConsole,
  agentSummary,
  pages,
  ViewState
} from "../apps/web/src/shell.js";
import { mountInteractions } from "../apps/web/src/main.js";

const session = {
  organization: "演示组织",
  permissions: Object.values(pages).map(page => page.permission)
};

test("shell renders landmarks, keyboard links and every authorized entry", () => {
  const html = renderConsole({ session, page: "home", preview: true });
  for (const label of [
    "主导航",
    "面包屑",
    "权限提示",
    "关键操作",
    "尚无交付记录"
  ])
    assert.ok(html.includes(label));
  assert.match(html, /href="#main"/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  for (const page of Object.keys(pages).filter(page => page !== "home")) {
    assert.ok(html.includes(`href="/preview/${page}"`));
    assert.match(
      renderConsole({ session, page, preview: true }),
      /aria-current="page"/
    );
  }
  assert.match(html, /aria-label="OctoAgent 中心节点与八条协作线路"/);
});

test("session and organization gate navigation and content before rendering", () => {
  const limited = { organization: "演示组织", permissions: ["overview"] };
  for (const context of [null, { ...session, organization: null }, limited]) {
    const html = renderConsole({ session: context, page: "contracts" });
    assert.doesNotMatch(html, /Agent 动作摘要|尚无交付记录|确认合同|<h1>合同/);
  }
  const html = renderConsole({ session: limited, page: "home" });
  assert.doesNotMatch(html, /href="\/console\/contracts"/);
  assert.match(html, /尚无交付记录/);
});

test("status views use fixed Chinese copy without resource identifiers or details", () => {
  for (const state of [
    "loading",
    "failed",
    "forbidden",
    "not-found",
    "form-error"
  ] as ViewState[]) {
    const html = renderConsole({ session, page: "home", state });
    assert.doesNotMatch(html, /尚无交付记录/);
    if (state !== "form-error") assert.doesNotMatch(html, /Agent 动作摘要/);
  }
  const unknown = renderConsole({
    session,
    page: "<script>private-resource</script>"
  });
  assert.match(unknown, /页面不存在/);
  assert.doesNotMatch(unknown, /private-resource/);
  assert.match(
    renderConsole({ session, page: "home", state: "form-error" }),
    /aria-describedby="goal-error"/
  );
});

test("organization and all four action fields are escaped", () => {
  const payload = '<img src=x onerror="alert(1)">';
  const html = agentSummary({
    actor: payload,
    permission: payload,
    object: payload,
    result: payload
  });
  assert.equal((html.match(/&lt;img/g) || []).length, 4);
  for (const label of ["执行者", "使用权限", "影响对象", "执行结果"])
    assert.ok(html.includes(label));
  assert.doesNotMatch(
    renderConsole({
      session: { ...session, organization: payload },
      page: "home"
    }),
    /<img/
  );
});

test("native submit validates, focuses the invalid field and never saves; retry reloads", () => {
  class Element extends EventTarget {
    value = "";
    textContent = "";
    attributes = new Map<string, string>();
    focused = false;
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
    }
    focus() {
      this.focused = true;
    }
  }
  const form = new Element();
  const input = new Element();
  const error = new Element();
  const result = new Element();
  const retry = new Element();
  const summary = new Element();
  const elements: Record<string, Element> = {
    "[data-form-summary]": summary,
    "[data-demo-form]": form,
    "#goal": input,
    "#goal-error": error,
    "[data-form-result]": result,
    "[data-retry]": retry
  };
  const root = ({
    querySelector: (selector: string) => elements[selector] || null
  } as unknown) as Document;
  let reloads = 0;
  mountInteractions(root, () => reloads++);
  input.value = "   ";
  const submit = new Event("submit", { cancelable: true });
  form.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(input.focused, true);
  assert.equal(input.attributes.get("aria-invalid"), "true");
  assert.equal(error.textContent, "请填写需求目标。");
  input.value = "演示目标";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.equal(input.attributes.get("aria-invalid"), "false");
  assert.equal(error.textContent, "");
  assert.match(result.textContent, /未保存或发布/);
  assert.equal(summary.attributes.get("role"), "status");
  assert.match(summary.textContent, /检查通过/);
  retry.dispatchEvent(new Event("click"));
  assert.equal(reloads, 1);
  mountInteractions(
    ({ querySelector: () => null } as unknown) as Document,
    () => {}
  );
});

test("responsive styles preserve key actions and visible keyboard focus", () => {
  const css = readFileSync("apps/web/app.css", "utf8");
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /display:\s*none/);
  assert.match(css, /var\(--coral\)/);
  assert.match(css, /var\(--sea\)/);
});
