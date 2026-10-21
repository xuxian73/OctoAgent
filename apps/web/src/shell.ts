export const pages = {
  home: { title: "交付总览", permission: "overview" },
  requirements: { title: "需求", permission: "requirements" },
  bids: { title: "报价", permission: "bids" },
  contracts: { title: "合同", permission: "contracts" },
  workspace: { title: "工作区", permission: "workspace" },
  acceptance: { title: "验收", permission: "acceptance" }
} as const;
export type Page = keyof typeof pages;
export type Session = {
  organization: string | null;
  permissions: readonly string[];
} | null;
export type ViewState =
  | "empty"
  | "loading"
  | "failed"
  | "forbidden"
  | "not-found"
  | "form-error";
export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return value.replace(/[&<>"']/g, character => entities[character]!);
}
export function logo(): string {
  return `<svg class="logo" viewBox="0 0 64 64" role="img" aria-label="OctoAgent 中心节点与八条协作线路"><g fill="none" stroke="currentColor" stroke-width="3"><path d="M26 26L14 14H4M32 24V4M38 26L50 14H60M40 32H60M38 38L50 50V60M32 40V56M26 38L14 50H4M24 32H4"/><circle cx="32" cy="32" r="9"/></g></svg>`;
}
export function agentSummary(action: {
  actor: string;
  permission: string;
  object: string;
  result: string;
}): string {
  return `<section class="panel" aria-labelledby="agent-title"><h2 id="agent-title">Agent 动作摘要</h2><dl>${Object.entries(
    {
      执行者: action.actor,
      使用权限: action.permission,
      影响对象: action.object,
      执行结果: action.result
    }
  )
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join("")}</dl></section>`;
}
const states = {
  empty: [
    "尚无交付记录",
    "从明确需求开始，将范围、报价和交付证据串成一条可追踪的记录。"
  ],
  loading: ["正在加载", "正在获取当前组织的内容，请稍候。"],
  failed: ["加载失败", "暂时无法获取内容，请重试。"],
  forbidden: [
    "权限不足",
    "当前上下文无法访问此内容。请联系组织管理员确认权限。"
  ],
  "not-found": ["页面不存在", "无法打开此页面，请返回交付总览。"],
  "form-error": ["请检查表单", "需求目标尚未填写。补齐后可重新检查。"]
} as const;
export function statePanel(state: ViewState, base: string): string {
  const [title, description] = states[state];
  return `<section class="panel state" ${
    state === "form-error" ? "data-form-summary" : ""
  } ${
    state === "loading"
      ? 'role="status" aria-busy="true"'
      : state === "failed" || state === "form-error"
      ? 'role="alert"'
      : ""
  }><h2>${title}</h2><p>${description}</p>${
    state === "failed"
      ? '<button type="button" data-retry>重新加载</button>'
      : state === "not-found"
      ? `<a href="${base}">返回交付总览</a>`
      : state === "form-error"
      ? '<a href="#goal">前往需求目标</a>'
      : ""
  }</section>`;
}
export function renderConsole(options: {
  session: Session;
  page: string;
  state?: ViewState;
  preview?: boolean;
}): string {
  const { session, preview = false } = options;
  const base = preview ? "/preview" : "/console";
  const page = Object.hasOwn(pages, options.page)
    ? (options.page as Page)
    : null;
  const allowed = (key: Page) =>
    !!session?.organization &&
    session.permissions.includes(pages[key].permission);
  const state =
    !session?.organization || (page && !allowed(page))
      ? "forbidden"
      : !page
      ? "not-found"
      : options.state || "empty";
  const title = !session
    ? "请先登录"
    : state === "forbidden"
    ? "权限不足"
    : state === "not-found"
    ? "页面不存在"
    : page
    ? pages[page].title
    : "页面不存在";
  const nav = session?.organization
    ? `<nav aria-label="主导航">${(Object.keys(pages) as Page[])
        .filter(allowed)
        .map(
          key =>
            `<a href="${base}${key === "home" ? "" : `/${key}`}" ${
              key === page ? 'aria-current="page"' : ""
            }>${pages[key].title}</a>`
        )
        .join("")}</nav>`
    : "";
  const actions = session?.organization
    ? `<nav class="actions" aria-label="关键操作">${([
        ["requirements", "发布需求"],
        ["bids", "提交报价"],
        ["contracts", "确认合同"],
        ["acceptance", "验收交付"]
      ] as const)
        .filter(([key]) => allowed(key))
        .map(([key, label]) => `<a href="${base}/${key}">${label}</a>`)
        .join("")}</nav>`
    : "";
  const content = !session
    ? `<section class="panel"><h2>登录后进入交付控制台</h2><p>当前未登录。身份接入完成后，可查看组织授权的需求与交付记录。</p><a href="/preview">查看应用壳演示</a></section>`
    : statePanel(state, base);
  const safeContent =
    session &&
    page &&
    allowed(page) &&
    !["forbidden", "not-found", "failed", "loading"].includes(state);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><a class="skip" href="#main">跳到主要内容</a><div class="shell"><aside class="sidebar"><a class="brand" href="${base}">${logo()}<span>OctoAgent<small>可验证的交付协作</small></span></a>${nav}</aside><div class="body"><header><span>${
    session?.organization ? escapeHtml(session.organization) : "尚未选择组织"
  }</span>${
    preview ? "<strong>演示模式 · 无真实会话或业务数据</strong>" : ""
  }</header><main id="main" tabindex="-1"><nav class="breadcrumb" aria-label="面包屑"><a href="${base}">控制台</a><span aria-current="page">${title}</span></nav><h1>${title}</h1><section class="notice" aria-label="权限提示"><p>${
    !session
      ? "登录后仅展示授权组织的内容。"
      : !session.organization
      ? "请先选择有权访问的组织。"
      : "当前展示范围由组织权限决定。发布、承诺和验收需责任人确认。"
  }</p>${
    preview
      ? "<p>此处仅演示入口与状态，不会发布需求、提交报价或确认验收。</p>"
      : ""
  }</section>${actions}<div class="columns"><div>${content}${
    safeContent && state === "form-error"
      ? '<form data-demo-form novalidate><label for="goal">需求目标（必填）</label><input id="goal" name="goal" required aria-invalid="true" aria-describedby="goal-error"><p id="goal-error" role="alert">请填写需求目标。</p><button type="submit">检查表单（演示）</button><p data-form-result role="status"></p></form>'
      : ""
  }</div>${
    safeContent
      ? agentSummary({
          actor: "暂无 Agent 动作",
          permission: "尚未授予操作权限",
          object: "无影响对象",
          result: "未执行任何操作"
        })
      : ""
  }</div>${
    preview
      ? `<nav class="state-links" aria-label="状态演示">${(Object.keys(
          states
        ) as ViewState[])
          .map(key => `<a href="${base}?state=${key}">${states[key][0]}</a>`)
          .join("")}<a href="/console">未登录</a></nav>`
      : ""
  }</main><footer>OctoAgent · 范围有据，交付可验</footer></div></div><script type="module" src="/app.js"></script></body></html>`;
}
