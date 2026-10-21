import {
  usernamePattern,
  passwordMaxLength
} from "../../../packages/shared/src/accounts.js";
let currentCsrf: string | undefined;
export async function sessionHeaders(): Promise<Record<string, string>> {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    if (typeof document !== "undefined")
      document.dispatchEvent(new Event("session-ended"));
    location.assign("/login?expired=1");
    throw new Error("登录已失效，请重新登录");
  }
  const result = await response.json();
  if (currentCsrf && currentCsrf !== result.data.csrf) {
    if (typeof document !== "undefined")
      document.dispatchEvent(new Event("session-ended"));
    location.assign("/login?expired=1");
    throw new Error("登录身份已变化，请重新进入项目");
  }
  currentCsrf = result.data.csrf;
  return { "X-CSRF-Token": result.data.csrf };
}
if (typeof document !== "undefined") {
  document.getElementById("logout")?.addEventListener("click", async () => {
    document.dispatchEvent(new Event("session-ended"));
    try {
      const headers = await sessionHeaders();
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers
      });
      if (!response.ok) throw new Error();
      location.assign("/login");
    } catch {
      const status = document.getElementById("session-status");
      if (status)
        status.textContent = "退出未完成，请重试退出登录。旧内容已清除。";
    }
  });
  document.getElementById("login-form")?.addEventListener("submit", event => {
    event.preventDefault();
    void (async () => {
      const username = document.getElementById("username") as HTMLInputElement;
      const password = document.getElementById("password") as HTMLInputElement;
      const body = JSON.stringify({
        username: username.value,
        password: password.value
      });
      password.value = "";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Octo-Login": "1" },
        body
      });
      if (response.ok) location.assign("/console");
      else
        document.getElementById("login-status")!.textContent =
          "登录失败，请检查账号密码或稍后重试。";
    })().catch(() => {
      document.getElementById("login-status")!.textContent =
        "登录失败，请稍后重试。";
    });
  });
}
export function renderLogin(expired = false): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>登录 OctoAgent</h1><p>${
    expired
      ? "登录已失效，请重新登录后继续。旧项目内容与待确认操作已清除。"
      : "使用本地账号登录；注册成功后请登录，再进入入驻流程选择角色。"
  }</p><form id="login-form" method="post" action="/api/auth/login"><label>账号<input id="username" autocomplete="username" required maxlength="64" pattern="${usernamePattern}"></label><label>密码<input id="password" type="password" autocomplete="current-password" required maxlength="${passwordMaxLength}"></label><button>登录</button></form><p id="login-status" role="status"></p><a href="/register">创建普通账户</a></main><script type="module" src="/session.js"></script></body></html>`;
}
