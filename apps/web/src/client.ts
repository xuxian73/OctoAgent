import { sessionHeaders } from "./session.js";

// A context transition permanently retires this document's client, including
// requests waiting for session validation or an already in-flight response.
let retired = false;
export function retireContext(root?: Document) {
  retired = true;
  root?.getElementById("main")?.replaceChildren();
  root?.getElementById("application-context")?.replaceChildren();
}
function active() {
  if (retired) throw new Error("上下文已切换，请在新页面继续操作");
}
export async function apiRequest(path: string, method = "GET", body?: unknown) {
  active();
  const headers = await sessionHeaders();
  active();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  active();
  const result = await response.json();
  active();
  if (!result.ok) {
    if (response.status === 401 || response.status === 403)
      await sessionHeaders();
    throw new Error(
      result.error.code === "FORBIDDEN"
        ? "当前账号无权执行此操作，授权可能已过期或撤销，请联系甲方重新授权后刷新"
        : ({
            FILE_SIZE_LIMIT: "文件超限，请缩小 ZIP 后重新上传",
            FILE_SCAN_BLOCKED:
              "扫描未放行，请刷新文件状态；扫描不可用时可重试扫描",
            CONTRACT_NOT_ACTIVE:
              "合同尚未生效、已暂停或处于争议，请返回合同处理后刷新",
            STALE_DELIVERY: "交付版本已更新，请刷新并下载当前版本后重新确认",
            STALE_VERSION: "页面版本已过期，请刷新后重新核对",
            INVALID_TRANSITION:
              "当前状态不允许此操作，请刷新并检查合同或里程碑状态"
          } as Record<string, string>)[result.error.code] || result.error.code
    );
  }
  return result.data;
}
export function mountApplication(
  root: Document,
  navigate: (url: string) => void,
  pathname: string
) {
  root.getElementById("project")?.addEventListener("change", event => {
    const project = (event.target as HTMLSelectElement).value;
    retireContext(root);
    navigate(pathname + "?project=" + encodeURIComponent(project));
  });
  root.addEventListener("session-ended", () => retireContext(root));
  mountNotifications(root);
}
if (typeof document !== "undefined") {
  mountApplication(document, url => location.assign(url), location.pathname);
  const refreshSession = () => {
    if (!retired) void sessionHeaders().catch(() => {});
  };
  refreshSession();
  const timer = window.setInterval(refreshSession, 60_000);
  window.addEventListener("pagehide", () => window.clearInterval(timer));
  window.addEventListener("pagehide", () => retireContext(document));
  window.addEventListener("pageshow", event => {
    if (event.persisted) location.reload();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !retired)
      void sessionHeaders().catch(() => {});
  });
}

export function mountNotifications(root: Document) {
  const container = root.getElementById("notification-items");
  const next = root.getElementById(
    "notification-next"
  ) as HTMLButtonElement | null;
  const refresh = root.getElementById("notification-refresh");
  if (!container || !next || !refresh) return;
  let cursor: number | null = null;
  let generation = 0;
  async function load(after = 0) {
    const current = ++generation;
    container!.replaceChildren();
    next!.hidden = true;
    try {
      const page = await apiRequest(
        "/api/market/notifications?cursor=" + after
      );
      if (current !== generation) return;
      cursor = page.nextCursor;
      for (const item of page.items) {
        const row = root.createElement("p");
        const link = root.createElement("a");
        link.href = item.href;
        link.textContent =
          "需求已变更 · 版本 " + item.version + " · 查看授权详情";
        const button = root.createElement("button");
        button.type = "button";
        button.textContent = item.readAt === null ? "标记已读" : "已读";
        button.disabled = item.readAt !== null;
        button.addEventListener("click", () => {
          button.disabled = true;
          void apiRequest(
            "/api/market/notifications/" +
              encodeURIComponent(item.requirementId) +
              "/" +
              item.version +
              "/read",
            "POST",
            {}
          )
            .then(() => load(after))
            .catch(() => load(after));
        });
        row.append(link, button);
        container!.append(row);
      }
      if (!page.items.length) container!.textContent = "暂无需求变更通知";
      next!.hidden = cursor === null;
    } catch {
      if (current === generation)
        container!.textContent = "通知加载失败，请刷新重试";
    }
  }
  refresh.addEventListener("click", () => {
    void load();
  });
  next.addEventListener("click", () => {
    if (cursor !== null) void load(cursor);
  });
  void load();
}
