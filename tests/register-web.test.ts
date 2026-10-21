import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { mountRegister, renderRegister } from "../apps/web/src/register.js";

test("registration form supports keyboard submit, safe errors, retry and login focus", async () => {
  class Element extends EventTarget {
    value = "";
    textContent = "";
    disabled = false;
    focused = false;
    focus() {
      this.focused = true;
    }
  }
  const elements = new Map(
    [
      "register-form",
      "register-submit",
      "register-status",
      "register-next",
      "username",
      "password"
    ].map(id => [id, new Element()])
  );
  const root = ({
    getElementById: (id: string) => elements.get(id)
  } as unknown) as Document;
  const originalFetch = globalThis.fetch;
  let succeed = false;
  let calls = 0;
  const secret = randomBytes(24).toString("hex");
  globalThis.fetch = (async (url, options) => {
    calls++;
    assert.equal(url, "/api/auth/register");
    assert.deepEqual(Object.keys(JSON.parse(options!.body as string)).sort(), [
      "password",
      "username"
    ]);
    assert.equal(elements.get("password")!.value, "");
    return new Response(null, { status: succeed ? 200 : 400 });
  }) as typeof fetch;
  try {
    const html = renderRegister();
    assert.match(html, /label for="username"/);
    assert.match(html, /label for="password"/);
    assert.match(html, /type="submit"/);
    assert.match(html, /role="status"/);
    mountRegister(root);
    elements.get("username")!.value = "keyboard-user";
    const submit = () =>
      elements
        .get("register-form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
    submit();
    assert.equal(calls, 0);
    assert.equal(elements.get("register-status")!.focused, true);
    elements.get("password")!.value = secret;
    submit();
    submit();
    assert.equal(calls, 1);
    await setImmediate();
    assert.match(elements.get("register-status")!.textContent, /注册未完成/);
    assert.equal(elements.get("register-submit")!.disabled, false);
    succeed = true;
    elements.get("password")!.value = secret;
    submit();
    await setImmediate();
    assert.equal(calls, 2);
    assert.match(elements.get("register-status")!.textContent, /注册成功/);
    assert.equal(elements.get("register-next")!.focused, true);
    for (const element of elements.values())
      assert.ok(!element.textContent.includes(secret));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser and server username rules agree on full strings including punctuation", async () => {
  const { usernamePattern, validUsername } = await import(
    "../packages/shared/src/accounts.js"
  );
  const browserPattern = new RegExp(`^(?:${usernamePattern})$`, "v");
  for (const value of ["a", "A_1.-", "x".repeat(64)]) {
    assert.equal(validUsername(value), true);
    assert.equal(browserPattern.test(value), true);
  }
  for (const value of ["a\n", "a\r", "a b", "", "x".repeat(65), "中文"]) {
    assert.equal(validUsername(value), false);
  }
});
