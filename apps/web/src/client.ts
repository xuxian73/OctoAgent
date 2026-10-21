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
        ? "当前账号无权执行此操作"
        : result.error.code
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
