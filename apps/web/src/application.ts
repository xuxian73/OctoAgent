import { escapeHtml, logo } from "./shell.js";
export interface ApplicationProject {
  id: string;
  organizationId: string;
  name: string;
  pages: string[];
}
export const businessPages: Record<string, string> = {
  requirements: "需求草稿",
  market: "需求与报价",
  contracts: "合同与验收",
  workspaces: "交付工作区"
};
export function renderApplication(
  html: string,
  page: string,
  projects: ApplicationProject[],
  selected?: ApplicationProject
) {
  const query = "?project=" + encodeURIComponent(selected?.id || "");
  const header = `<a class="skip-link" href="#main">跳到主要内容</a><header>${logo()}<span>OctoAgent · 交付控制台</span><button id="logout" type="button">退出登录</button><p id="session-status" role="status"></p></header><div class="shell"><aside id="application-context" class="sidebar"><label for="project">授权项目</label><select id="project" ${
    projects.length ? "" : "disabled"
  }>${projects
    .map(
      p =>
        `<option value="${escapeHtml(p.id)}" ${
          p.id === selected?.id ? "selected" : ""
        }>${escapeHtml(p.name)}</option>`
    )
    .join("")}</select><nav aria-label="主导航">${Object.entries(businessPages)
    .filter(([key]) => selected?.pages.includes(key))
    .map(
      ([key, label]) =>
        `<a href="/${key}${query}" ${
          key === page ? 'aria-current="page"' : ""
        }>${label}</a>`
    )
    .join(
      ""
    )}<a href="/agents">我的 Agent</a><a href="/onboarding">选择身份 / 完善资料</a><a href="/market">可接任务入口</a></nav><section id="notifications" aria-label="需求变更通知"><h2>需求变更通知</h2><div id="notification-items" role="status"></div><button id="notification-refresh" type="button">刷新通知</button><button id="notification-next" type="button" hidden>下一页</button></section><p>仅显示当前项目获准使用的入口；业务操作仍独立校验权限。</p></aside>`;
  return html
    .replace("<body>", "<body>" + header)
    .replace(
      '<main class="requirement-editor">',
      '<main id="main" tabindex="-1" class="requirement-editor">'
    )
    .replace(
      "</main>",
      '</main></div><script type="module" src="/client.js"></script>'
    );
}
export function emptyApplication(message: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>${message}</h1></main></body></html>`;
}
