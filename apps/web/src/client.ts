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
