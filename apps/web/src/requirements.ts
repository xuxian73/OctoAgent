import {
  fields,
  Field,
  taskTypes,
  budgetTypes,
  currency,
  Draft
} from "../../../packages/requirements/src/model.js";
export function renderRequirementEditor() {
  const controls = (Object.entries(fields) as [Field, string][])
    .map(([key, label]) => {
      const options =
        key === "taskType"
          ? taskTypes
          : key === "budgetType"
          ? budgetTypes
          : key === "currency"
          ? [currency]
          : null;
      return `<fieldset><label for="${key}">${label}</label>${
        options
          ? `<select id="${key}" name="${key}">${
              key === "currency" ? "" : '<option value="">请选择</option>'
            }${options
              .map(value => `<option>${value}</option>`)
              .join("")}</select>`
          : `<textarea id="${key}" name="${key}" maxlength="10000" rows="2"></textarea>`
      }<label><input type="checkbox" data-public="${key}">明确允许公开此字段（确认不含敏感信息）</label></fieldset>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需求草稿 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main id="main" class="requirement-editor"><h1>需求草稿</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><a href="/market">发现需求与比较报价</a><p>填写目标、预算和验收标准，保存后检查缺失字段。所有文字和附件默认私密。发布需要甲方本人确认。</p><p>使用身份服务签发的会话；凭据仅留在当前页面内存中。</p><label for="session">会话凭据</label><input id="session" type="password" autocomplete="off"><label for="project">项目 ID</label><input id="project"><label for="draft-id">草稿 ID（保存后可复制，下次加载）</label><input id="draft-id"><button id="load" type="button">加载草稿</button><form id="requirement-form"><fieldset><legend>需求发现设置（启用后随发布版本生效）</legend><label><input id="market-enabled" type="checkbox">进入授权项目的需求列表</label><label>报价截止时间<input id="market-deadline" type="datetime-local"></label><label>期望周期（天）<input id="market-days" type="number" min="1"></label><label>风险等级<select id="market-risk"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label><input id="market-agents" type="checkbox">允许 Agent</label><p>启用发现需明确公开目标、交付物、验收标准、权限边界、技术栈、任务类型、预算方式和期望时间。</p></fieldset>${controls}<button type="submit">保存草稿</button><button id="preview-summary" type="button">检查并查看发布摘要</button></form><p id="status" role="status" aria-live="polite"></p><section id="confirmation" hidden><h2>发布前确认</h2><div id="summary"></div><label><input id="confirmed" type="checkbox">我已确认范围、预算、交付物、验收标准及公开字段</label><button id="publish" type="button">确认发布此版本</button></section><section><h2>版本变更记录</h2><ul id="changes"></ul></section><section><h2>附件元数据</h2><p>仅登记元数据，不上传文件内容。支持 PDF、TXT、PNG、JPG，最大 10 MiB。</p><input id="attachment" type="file" accept=".pdf,.txt,.png,.jpg" aria-label="选择附件"><label><input id="attachment-public" type="checkbox">允许公开附件名称及元数据</label><button id="add-attachment" type="button">保存附件元数据</button><ul id="attachments"></ul></section></main><script type="module" src="/requirements.js"></script></body></html>`;
}
export function mountRequirementEditor(root: Document) {
  const form = root.querySelector<HTMLFormElement>("#requirement-form");
  if (!form) return;
  const input = (id: string) => root.getElementById(id) as HTMLInputElement;
  const status = root.getElementById("status")!;
  let revision = 0;
  let confirmation = "";
  const invalidate = () => {
    confirmation = "";
    root.getElementById("confirmation")!.hidden = true;
    input("confirmed").checked = false;
  };
  form.addEventListener("input", invalidate);
  for (const id of ["draft-id", "session", "project"])
    input(id).addEventListener("input", () => {
      revision = 0;
      invalidate();
    });
  const draft = (): Draft => ({
    ...(input("market-enabled")?.checked
      ? {
          market: {
            deadline: new Date(input("market-deadline").value).getTime(),
            durationDays: Number(input("market-days").value),
            risk: input("market-risk").value as "low" | "medium" | "high",
            allowAgents: input("market-agents").checked
          }
        }
      : {}),
    values: Object.fromEntries(
      Object.keys(fields).map(key => [key, input(key).value])
    ),
    publicFields: Array.from(
      root.querySelectorAll<HTMLInputElement>("[data-public]")
    )
      .filter(el => el.checked)
      .map(el => el.dataset.public as Field)
  });
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch("/api/requirements" + path, {
      method,
      headers: {
        Authorization: "Bearer " + input("session").value,
        "Content-Type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
  }
  function display(data: {
    id: string;
    revision: number;
    version: number;
    draft: Draft;
    validation: { missing: Field[]; invalid: Field[]; risks: string[] };
    attachments: { name: string; private: number }[];
    changes: { version: number; changed_fields: string }[];
  }) {
    if (input("market-enabled")) {
      input("market-enabled").checked = !!data.draft.market;
      const market = data.draft.market;
      input("market-deadline").value = market
        ? new Date(
            market.deadline -
              new Date(market.deadline).getTimezoneOffset() * 60000
          )
            .toISOString()
            .slice(0, 16)
        : "";
      input("market-days").value = market ? String(market.durationDays) : "";
      input("market-risk").value = market?.risk || "low";
      input("market-agents").checked = market?.allowAgents || false;
    }
    revision = data.revision;
    input("draft-id").value = data.id;
    for (const key of Object.keys(fields) as Field[])
      input(key).value = data.draft.values[key] || "";
    root.querySelectorAll<HTMLInputElement>("[data-public]").forEach(el => {
      el.checked = data.draft.publicFields.includes(el.dataset.public as Field);
    });
    const missing = [...data.validation.missing, ...data.validation.invalid];
    status.textContent = `已保存；发布版本 ${data.version}。${
      missing.length
        ? "请补全或修正：" + missing.map(key => fields[key]).join("、")
        : "字段完整，可查看摘要。"
    } ${data.validation.risks.join(" ")}`;
    const changes = root.getElementById("changes")!;
    changes.replaceChildren();
    for (const change of data.changes) {
      const li = root.createElement("li");
      li.textContent = `版本 ${change.version}：${(JSON.parse(
        change.changed_fields
      ) as string[])
        .map(
          key =>
            fields[key as Field] ||
            (key === "publicFields" ? "公开字段" : "附件")
        )
        .join("、")}`;
      changes.append(li);
    }
    displayAttachments(data.attachments);
  }
  function displayAttachments(
    attachments: { name: string; private: number }[]
  ) {
    const list = root.getElementById("attachments")!;
    list.replaceChildren();
    for (const item of attachments) {
      const li = root.createElement("li");
      li.textContent = `${item.name}（${
        item.private ? "私密" : "公开元数据"
      }）`;
      list.append(li);
    }
  }
  async function save() {
    invalidate();
    const id = input("draft-id").value;
    if (id && !revision) throw new Error("请先加载草稿");
    display(
      await api(id ? "/" + encodeURIComponent(id) : "", id ? "PUT" : "POST", {
        projectId: input("project").value,
        revision,
        draft: draft()
      })
    );
  }
  const run = (fn: () => Promise<void>) => {
    void fn().catch(error => {
      if (error.message === "REVISION_CONFLICT") {
        status.textContent =
          "版本冲突：本地编辑已保留。请先复制本地修改，再加载最新草稿并核对合并后保存。";
        return;
      }
      status.textContent = `操作未完成：${error.message}。如版本冲突，请加载最新草稿。`;
    });
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    run(save);
  });
  input("load").addEventListener("click", () =>
    run(async () => {
      invalidate();
      display(await api("/" + encodeURIComponent(input("draft-id").value)));
    })
  );
  input("preview-summary").addEventListener("click", () =>
    run(async () => {
      await save();
      const data = await api(
        "/" + encodeURIComponent(input("draft-id").value) + "/preview",
        "POST",
        {}
      );
      confirmation = data.confirmation;
      const node = root.getElementById("summary")!;
      node.replaceChildren();
      for (const [key, label] of [
        ["scope", "范围"],
        ["budget", "预算"],
        ["deliverables", "交付物"],
        ["acceptance", "验收标准"],
        ["attachments", "附件元数据"],
        ...(data.summary.market
          ? [["market", "发现条件：截止时间、周期、风险与 Agent 权限"]]
          : [])
      ]) {
        const heading = root.createElement("h3");
        heading.textContent = label!;
        const content = root.createElement("pre");
        const value = data.summary[key!];
        content.textContent =
          typeof value === "string"
            ? value
            : key === "attachments"
            ? value
                .map(
                  (item: { name: string; private: number }) =>
                    `${item.name}（${item.private ? "私密" : "公开元数据"}）`
                )
                .join("\n")
            : Object.entries(value)
                .map(
                  ([field, text]) =>
                    `${fields[field as Field] ||
                      (field === "type" ? "预算方式" : field)}：${text}`
                )
                .join("\n");
        node.append(heading, content);
      }
      root.getElementById("confirmation")!.hidden = false;
    })
  );
  input("publish").addEventListener("click", () =>
    run(async () => {
      if (!input("confirmed").checked || !confirmation)
        throw new Error("请确认四项摘要");
      display(
        await api(
          "/" + encodeURIComponent(input("draft-id").value) + "/publish",
          "POST",
          { confirmation, confirmed: true }
        )
      );
      invalidate();
    })
  );
  input("add-attachment").addEventListener("click", () =>
    run(async () => {
      if (!revision) throw new Error("请先保存或加载草稿");
      invalidate();
      const file = input("attachment").files?.[0];
      if (!file) throw new Error("请选择文件");
      const data = await api(
        "/" + encodeURIComponent(input("draft-id").value) + "/attachments",
        "POST",
        {
          revision,
          name: file.name,
          mime: file.type,
          size: file.size,
          private: !input("attachment-public").checked
        }
      );
      revision = data.revision;
      displayAttachments(data.attachments);
      status.textContent = "附件元数据已保存；表单中的编辑已保留，请保存草稿。";
    })
  );
}
if (typeof document !== "undefined") mountRequirementEditor(document);
