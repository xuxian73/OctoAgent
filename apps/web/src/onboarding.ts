import { sessionHeaders } from "./session.js";

export function renderOnboarding() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>首次使用 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>创建首个项目</h1><p>建立组织和项目后，你将成为甲方成员，获得组织读取、项目读取与编写需求草稿的权限。不包含合同、私有仓库或生产权限。</p><form id="onboarding-form"><label>组织名称<input id="organization-name" required maxlength="80"></label><label>项目名称<input id="project-name" required maxlength="80"></label><button id="initialize">创建组织与项目</button></form><p id="onboarding-status" role="status" aria-live="polite"></p><a href="/console">返回控制台</a></main><script type="module" src="/onboarding.js"></script></body></html>`;
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
      if (result.data.canInitialize) location.assign("/onboarding");
      else status.textContent = "暂无获准访问的项目，请联系组织负责人。";
    }
  } catch {
    status.textContent = "无法加载项目，请刷新重试。";
  }
}
if (typeof document !== "undefined") {
  mountOnboarding(document);
  void mountProjectContext(document);
}
