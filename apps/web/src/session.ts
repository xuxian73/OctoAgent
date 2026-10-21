export async function sessionHeaders(): Promise<Record<string, string>> {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    location.assign("/login");
    throw new Error("请先登录");
  }
  const result = await response.json();
  return { "X-CSRF-Token": result.data.csrf };
}
if (typeof document !== "undefined") {
  document.getElementById("logout")?.addEventListener("click", async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: await sessionHeaders()
    });
    if (response.ok) location.assign("/login");
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
export function renderLogin(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>登录 OctoAgent</h1><p>请使用部署者提供的本地账号。</p><form id="login-form" method="post" action="/api/auth/login"><label>账号<input id="username" autocomplete="username" required maxlength="64"></label><label>密码<input id="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>登录</button></form><p id="login-status" role="status"></p></main><script type="module" src="/session.js"></script></body></html>`;
}
export function renderSignedIn(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>控制台 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付控制台</h1><p>已登录。业务数据仍按现有组织、项目和资源权限校验。</p><nav><a href="/requirements">需求草稿</a> <a href="/market">需求与报价</a> <a href="/contracts">合同与验收</a> <a href="/workspaces">交付工作区</a></nav><button id="logout">退出登录</button></main><script type="module" src="/session.js"></script></body></html>`;
}
