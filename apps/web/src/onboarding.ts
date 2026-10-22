const escapeHtml = (value: string) => {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return value.replace(/[&<>"']/g, char => entities[char]!);
};
import { sessionHeaders } from "./session.js";

export function renderOnboarding(profile?: Record<string, unknown> | null) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>首次使用 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>选择业务身份</h1><p>可选择发布需求或承接任务，也可同时使用两种身份。业务身份不会改变已有项目与合同权限。</p><nav><a href="#buyer">发布需求</a><a href="#seller">承接任务</a></nav><h2 id="buyer">创建首个项目</h2><p>建立组织和项目后，你将成为甲方成员，获得组织读取、项目读取与编写需求草稿的权限。不包含合同、私有仓库或生产权限。</p><form id="onboarding-form"><label>组织名称<input id="organization-name" required maxlength="80"></label><label>项目名称<input id="project-name" required maxlength="80"></label><button id="initialize">创建组织与项目</button></form><h2 id="seller">乙方资料</h2><p>以当前账户作为责任主体，无需创建甲方项目。</p><form id="seller-form" data-editing="${
    profile ? "true" : "false"
  }">${([
    ["displayName", "显示名称", 80],
    ["capabilities", "能力 / 技术栈", 500],
    ["taskTypes", "可接任务类型", 500],
    ["bio", "简介", 1000]
  ] as const)
    .map(
      ([key, label, limit]) =>
        `<label>${label}<input id="seller-${key}" required maxlength="${limit}" value="${escapeHtml(
          String(profile?.[key] || "")
        )}"></label>`
    )
    .join("")}<button id="save-seller">${
    profile ? "保存乙方资料" : "完成乙方入驻"
  }</button></form><p id="seller-status" role="status" aria-live="polite"></p><a href="/market">进入可接任务</a><p id="onboarding-status" role="status" aria-live="polite"></p><a href="/console">返回控制台</a></main><script type="module" src="/onboarding.js"></script></body></html>`;
}
export function mountOnboarding(root: Document) {
  const form = root.getElementById("onboarding-form");
  if (!form) return;
  const status = root.getElementById("onboarding-status")!;
  const button = root.getElementById("initialize") as HTMLButtonElement;
  let pending: { body: string; key: string } | undefined;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (button.disabled) return;
    const body = JSON.stringify({
      organizationName: (root.getElementById(
        "organization-name"
      ) as HTMLInputElement).value,
      projectName: (root.getElementById("project-name") as HTMLInputElement)
        .value
    });
    if (!pending || pending.body !== body)
      pending = { body, key: crypto.randomUUID() };
    const submission = pending;
    button.disabled = true;
    void (async () => {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: {
          ...(await sessionHeaders()),
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key
        },
        body: submission.body
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error.code);
      location.assign(
        "/requirements?project=" + encodeURIComponent(result.data.projectId)
      );
    })()
      .catch(() => {
        status.textContent =
          "创建未完成，请检查名称后重试；若已创建，请返回控制台选择项目。";
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

export function mountSeller(root: Document) {
  const form = root.getElementById("seller-form");
  if (!form) return;
  const button = root.getElementById("save-seller") as HTMLButtonElement;
  const status = root.getElementById("seller-status")!;
  let pending: { body: string; key: string } | undefined;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (button.disabled) return;
    const body = JSON.stringify(
      Object.fromEntries([
        ["role", "seller"],
        ...["displayName", "capabilities", "taskTypes", "bio"].map(key => [
          key,
          (root.getElementById("seller-" + key) as HTMLInputElement).value
        ])
      ])
    );
    if (!pending || pending.body !== body)
      pending = { body, key: crypto.randomUUID() };
    const submission = pending;
    button.disabled = true;
    void (async () => {
      const editing = form.dataset.editing === "true";
      const response = await fetch(
        editing ? "/api/onboarding/seller" : "/api/onboarding",
        {
          method: editing ? "PUT" : "POST",
          headers: {
            ...(await sessionHeaders()),
            "Content-Type": "application/json",
            "Idempotency-Key": submission.key
          },
          body: submission.body
        }
      );
      const result = await response.json();
      if (!result.ok) throw new Error(result.error?.code || "SAVE_FAILED");
      location.assign("/market");
    })()
      .catch(error => {
        status.textContent =
          error.message === "BODY_TOO_LARGE"
            ? "资料请求超过 16 KiB，请缩短资料后重试。"
            : "保存未完成：名称最多 80 字、能力与任务类型各 500 字、简介 1000 字；请检查后重试。";
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

export async function mountProjectContext(root: Document) {
  const select = root.getElementById("project") as HTMLSelectElement | null;
  if (!select || select.tagName !== "SELECT") return;
  const status = root.getElementById("status")!;
  try {
    await sessionHeaders();
    const response = await fetch("/api/contexts", { cache: "no-store" });
    const result = await response.json();
    if (!result.ok) throw new Error();
    const requested = new URL(location.href).searchParams.get("project");
    select.replaceChildren();
    for (const project of result.data.projects) {
      const option = root.createElement("option");
      option.value = project.id;
      const organization = result.data.organizations.find(
        (o: { id: string }) => o.id === project.organizationId
      );
      option.textContent =
        (organization ? organization.name + " / " : "") + project.name;
      select.append(option);
    }
    if (result.data.projects.some((p: { id: string }) => p.id === requested))
      select.value = requested!;
    if (!result.data.projects.length) {
      if (result.data.canInitialize && !result.data.sellerProfile)
        location.assign("/onboarding");
      else status.textContent = "暂无获准访问的项目，请联系组织负责人。";
    }
  } catch {
    status.textContent = "无法加载项目，请刷新重试。";
  }
}
if (typeof document !== "undefined") {
  mountOnboarding(document);
  mountSeller(document);
  // The onboarding shell has no selected project; do not redirect its own form.
  if (!document.getElementById("onboarding-form"))
    void mountProjectContext(document);
}
