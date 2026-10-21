import {
  usernamePattern,
  passwordMinLength,
  passwordMaxLength,
  validAccount
} from "../../../packages/shared/src/accounts.js";

export function renderRegister(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>注册 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>创建普通账户</h1><p id="register-help">用户名区分大小写，使用 1–64 个英文字母、数字、下划线、点或连字符。密码长度为 ${passwordMinLength}–${passwordMaxLength}（部分字符如 emoji 占两个长度单位）。注册不授予已有组织或项目权限。成功后请正常登录并继续入驻。</p><form id="register-form" aria-describedby="register-help"><label for="username">用户名</label><input id="username" autocomplete="username" required maxlength="64" pattern="${usernamePattern}"><label for="password">密码</label><input id="password" type="password" autocomplete="new-password" required minlength="${passwordMinLength}" maxlength="${passwordMaxLength}"><button id="register-submit" type="submit">注册</button></form><p id="register-status" role="status" aria-live="polite" tabindex="-1"></p><a id="register-next" href="/login">已有账户？前往登录</a></main><script type="module" src="/register.js"></script></body></html>`;
}
export function mountRegister(root: Document) {
  const form = root.getElementById("register-form");
  if (!form) return;
  const button = root.getElementById("register-submit") as HTMLButtonElement;
  const status = root.getElementById("register-status")!;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (button.disabled) return;
    const username = root.getElementById("username") as HTMLInputElement;
    const password = root.getElementById("password") as HTMLInputElement;
    if (!validAccount(username.value, password.value)) {
      status.textContent = "请按说明填写用户名和密码。";
      status.focus();
      return;
    }
    const body = JSON.stringify({
      username: username.value,
      password: password.value
    });
    password.value = "";
    button.disabled = true;
    void (async () => {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Octo-Register": "1" },
        body
      });
      if (!response.ok) throw new Error();
      status.textContent = "注册成功。请前往登录，然后继续入驻。";
      const next = root.getElementById("register-next")!;
      next.textContent = "前往登录并继续入驻";
      next.focus();
    })()
      .catch(() => {
        status.textContent =
          "注册未完成，请检查输入、尝试其他用户名或稍后重试。";
        status.focus();
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}
if (typeof document !== "undefined") mountRegister(document);
