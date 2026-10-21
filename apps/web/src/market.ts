import { apiRequest } from "./client.js";
import {
  proposalFields,
  Proposal
} from "../../../packages/requirements/src/bids.js";
export function renderMarket() {
  const input = (id: string, label: string, type = "text") =>
    `<label>${label}<input id="${id}" type="${type}" autocomplete="off"></label>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需求与报价 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>需求与报价</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>公开市场仅显示甲方已发布的公开内容。报价按能力、风险和周期综合比较。</p><section><h2>发现需求</h2>${input(
    "stack",
    "技术栈"
  )}${input("taskType", "任务类型")}${input("budgetType", "预算方式")}${input(
    "maxDays",
    "最长周期（天）",
    "number"
  )}<label>风险等级<select id="risk"><option value="">全部</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label>允许 Agent<select id="allowAgents"><option value="">全部</option><option value="true">是</option><option value="false">否</option></select></label><button id="search">搜索</button><div id="results"></div></section>${input(
    "task",
    "需求 ID"
  )}<button id="detail">加载详情与时间线</button><div id="context"></div><section><h2>报价草稿</h2><p>列表字段每行一项；无前置条件等请明确填写“无”。每次保存生成不可修改的新版本。</p>${Object.entries(
    proposalFields
  )
    .map(
      ([key, label]) =>
        `<label>${label}${
          ["hours", "days", "price"].includes(key)
            ? `<input id="bid-${key}" type="number" min="0.01" step="0.01">`
            : key === "risk"
            ? '<select id="bid-risk"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>'
            : `<textarea id="bid-${key}" rows="2"></textarea>`
        }</label>`
    )
    .join("")}<button id="draft">保存新报价版本</button>${input(
    "bid",
    "报价 ID"
  )}<button id="preview">查看责任主体确认摘要</button><pre id="summary"></pre><label><input id="confirmed" type="checkbox">本人确认该版本的方案、价格、周期、风险与权限需求</label><button id="submit">确认提交</button><button id="withdraw">撤回此版本</button>${input(
    "supplement",
    "补充说明（不改变需求范围）"
  )}<button id="add-supplement">补充说明</button><button id="history">加载报价版本</button><pre id="versions"></pre></section><section><h2>并排比较</h2><label>排序<select id="sort"><option value="risk">风险优先</option><option value="capabilities">能力标签数量（自述）</option><option value="days">周期</option><option value="price">价格（同时比较风险与周期）</option></select></label><button id="compare">比较最新有效报价</button><div id="comparison" style="overflow-x:auto"></div></section><section><h2>澄清与时间线</h2><p>定向问题与回复仅获准甲方和对应卖方责任主体可见。回复不会修改已发布需求版本或合同范围，也不会授予附件或仓库权限。</p>${input(
    "recipient",
    "提问对象（责任主体 ID 或 all）"
  )}${input("topic", "问题主题")}${input(
    "question",
    "问题内容"
  )}<button id="ask">向报价方提问</button><button id="clarify">向甲方提出澄清</button>${input(
    "question-id",
    "原问题序号（甲方回复卖方澄清；卖方回复甲方提问）",
    "number"
  )}${input("answer", "结构化回答")}${input("evidence", "证据")}${input(
    "impact",
    "对范围、风险与周期的影响"
  )}<button id="answer-question">提交回答</button></section><p id="status" role="status" aria-live="polite"></p></main><script type="module" src="/market.js"></script></body></html>`;
}
export function mountMarket(root: Document) {
  const input = (id: string) => root.getElementById(id) as HTMLInputElement;
  if (!input("search")) return;
  let confirmation = "";
  const clear = () => {
    confirmation = "";
    input("confirmed").checked = false;
    input("summary").textContent = "";
  };
  for (const id of ["bid", "task"]) input(id).addEventListener("input", clear);
  async function api(path: string, body?: unknown) {
    return apiRequest(
      "/api/market" + path,
      body === undefined ? "GET" : "POST",
      body
    );
  }

  const task = () => "/" + encodeURIComponent(input("task").value);
  const bid = () => "/bids/" + encodeURIComponent(input("bid").value);
  function on(id: string, fn: () => Promise<void>) {
    input(id).addEventListener("click", () => {
      void fn()
        .then(() => {
          input("status").textContent = "操作完成";
        })
        .catch(e => {
          if (input("status"))
            input("status").textContent = "操作未完成：" + e.message;
        });
    });
  }
  on("search", async () => {
    const params = new URLSearchParams({
      projectId: input("project")?.value || ""
    });
    for (const k of [
      "stack",
      "taskType",
      "budgetType",
      "maxDays",
      "risk",
      "allowAgents"
    ])
      if (input(k).value) params.set(k, input(k).value);
    const data = await api("?" + params);
    input("results").replaceChildren();
    for (const row of data) {
      const button = root.createElement("button");
      button.textContent =
        row.values.goal +
        " · " +
        new Date(row.market.deadline).toLocaleString();
      button.addEventListener("click", () => {
        input("task").value = row.id;
        clear();
        input("detail").click();
      });
      input("results").append(button);
    }
    if (!data.length) input("results").textContent = "暂无符合条件的需求";
  });
  on("detail", async () => {
    const data = await api(task());
    const container = input("context");
    container.replaceChildren();
    const labels: Record<string, string> = {
      goal: "目标",
      deliverables: "交付物",
      acceptance: "验收标准",
      permissions: "所需权限",
      exclusions: "不可触碰范围",
      stack: "技术栈",
      taskType: "任务类型",
      budgetType: "预算方式",
      timeline: "期望时间"
    };
    const line = (label: string, value: string) => {
      const p = root.createElement("p");
      p.textContent = label + "：" + value;
      container.append(p);
    };
    line("需求版本", String(data.version));
    line("报价截止时间", new Date(data.market.deadline).toLocaleString());
    line("期望周期（天）", String(data.market.durationDays));
    line("风险等级", data.market.risk);
    line("允许 Agent", data.market.allowAgents ? "是" : "否");
    for (const [key, value] of Object.entries(data.values))
      line(labels[key] || key, String(value));
    line(
      "公开附件",
      data.attachments.map((a: { name: string }) => a.name).join("、") ||
        "无（私密附件默认隐藏）"
    );
    line("任务时间线", "按时间和事件序号排序；澄清不会修改需求范围");
    for (const event of data.timeline) {
      line(
        `#${event.sequence} · ${new Date(
          event.created_at
        ).toLocaleString()} · ${event.actor_id} · ${event.kind}`,
        event.kind === "answer"
          ? `回复原问题 #${event.payload.questionId}：${event.payload.answer}；证据：${event.payload.evidence}；影响说明：${event.payload.impact}`
          : JSON.stringify(event.payload)
      );
      if (["question", "clarification"].includes(event.kind)) {
        const reply = root.createElement("button");
        reply.textContent = `回复${
          event.kind === "clarification" ? "卖方澄清" : "甲方提问"
        } #${event.sequence}`;
        reply.addEventListener("click", () => {
          input("question-id").value = String(event.sequence);
        });
        container.append(reply);
      }
    }
  });
  on("draft", async () => {
    const proposal = Object.fromEntries(
      Object.keys(proposalFields).map(k => [
        k,
        ["hours", "days", "price"].includes(k)
          ? Number(input("bid-" + k).value)
          : ["summary", "risk"].includes(k)
          ? input("bid-" + k).value
          : input("bid-" + k)
              .value.split("\n")
              .filter(Boolean)
      ])
    );
    const data = await api(task() + "/bids", { proposal });
    input("bid").value = data.id;
    clear();
  });
  on("preview", async () => {
    clear();
    const data = await api(bid() + "/preview", {});
    confirmation = data.confirmation;
    input("summary").textContent = JSON.stringify(data.bid, null, 2);
  });
  on("submit", async () => {
    await api(bid() + "/submit", {
      confirmation,
      confirmed: input("confirmed").checked
    });
    clear();
  });
  on("withdraw", async () => {
    await api(bid() + "/withdraw", {});
    clear();
  });
  on("add-supplement", async () => {
    await api(bid() + "/supplements", { text: input("supplement").value });
  });
  on("history", async () => {
    input("versions").textContent = JSON.stringify(
      (await api(task() + "/bids")).map((bid: { stale: boolean }) => ({
        ...bid,
        需求版本状态: bid.stale
          ? "历史需求版本，不参与有效比较"
          : "当前需求版本"
      })),
      null,
      2
    );
  });
  on("compare", async () => {
    const bids = await api(task() + "/compare?sort=" + input("sort").value);
    renderComparison(root, input("comparison"), bids);
  });
  on("ask", async () => {
    await api(task() + "/questions", {
      recipient: input("recipient").value,
      topic: input("topic").value,
      text: input("question").value
    });
    input("detail").click();
  });
  if (input("clarify"))
    on("clarify", async () => {
      await api(task() + "/clarifications", {
        topic: input("topic").value,
        text: input("question").value
      });
      input("detail").click();
    });
  on("answer-question", async () => {
    await api(task() + "/answers", {
      questionId: Number(input("question-id").value),
      answer: input("answer").value,
      evidence: input("evidence").value,
      impact: input("impact").value
    });
    input("detail").click();
  });
  const linkedTask =
    typeof location !== "undefined"
      ? new URLSearchParams(location.search).get("task")
      : null;
  if (linkedTask) {
    input("task").value = linkedTask;
    input("detail").click();
  }
}
export function renderComparison(
  root: Document,
  container: HTMLElement,
  bids: {
    owner_id: string;
    version: number;
    task_version: number;
    proposal: Proposal;
  }[]
) {
  container.replaceChildren();
  if (!bids.length) {
    container.textContent = "暂无有效报价";
    return;
  }
  const table = root.createElement("table");
  const header = root.createElement("tr");
  for (const label of [
    "比较维度",
    ...bids.map(
      b => `${b.owner_id} · 报价版本 ${b.version} · 需求版本 ${b.task_version}`
    )
  ]) {
    const th = root.createElement("th");
    th.textContent = label;
    header.append(th);
  }
  table.append(header);
  for (const [key, label] of Object.entries(proposalFields)) {
    const row = root.createElement("tr");
    const th = root.createElement("th");
    th.textContent = label;
    row.append(th);
    for (const bid of bids) {
      const td = root.createElement("td");
      const value = bid.proposal[key as keyof Proposal];
      td.textContent = Array.isArray(value) ? value.join("；") : String(value);
      row.append(td);
    }
    table.append(row);
  }
  container.append(table);
}
if (typeof document !== "undefined") mountMarket(document);
