import { apiRequest } from "./client.js";
export function renderContracts() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合同与验收 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>我的报价/订单</h1><div id="orders"></div><div id="my-bids"></div><a id="workspace" hidden>接单 / 进入工作区</a><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>无 ZIP 交付版本的历史状态不代表本次真实 ZIP 交付。双方确认后合同才生效。范围变更生成新版本并重新确认。争议冻结后续推进。结算仅记账，不执行支付。</p><label>选定报价 ID<input id="bid"></label><button id="select">确认选择报价并生成草案</button><label>合同 ID<input id="contract"></label><button id="load">读取合同</button><pre id="snapshot"></pre><label>当前版本条款（变更时编辑 JSON，里程碑每版重新验收）<textarea id="terms" rows="12"></textarea></label><label>当前版本里程碑<select id="milestone"></select></label><label>目标状态<select id="target">${[
    "pending_confirmation",
    "active",
    "paused",
    "completed",
    "cancelled",
    "disputed",
    "in_progress",
    "changes_requested",
    "accepted",
    "rejected"
  ]
    .map(s => `<option>${s}</option>`)
    .join(
      ""
    )}</select></label><label>原因类别<input id="reason-code"></label><label>原因说明<textarea id="reason-detail"></textarea></label><label>验收报告草稿（交付请进入工作区上传 ZIP）<textarea id="evidence"></textarea></label><label><input id="confirmed" type="checkbox">我已阅读当前版本、影响对象和原因，人工确认本次操作</label><button id="transition">更新合同状态 / 发起争议</button><button id="confirm">代表本方确认当前版本</button><button id="change">提出新范围版本</button><button id="milestone-action">更新里程碑 / 验收 / 要求修改</button><button id="review">仅保存验收报告草稿（不验收）</button><button id="settlement">人工确认结算记录</button><p id="status" role="status"></p></main><script type="module" src="/contracts.js"></script></body></html>`;
}
export function mountContracts(root: Document = document) {
  const el = (id: string) => root.getElementById(id)!;
  const val = (id: string) => (el(id) as HTMLInputElement).value;
  let current:
    | {
        id: string;
        status: string;
        milestones: {
          id: string;
          version: number;
          title: string;
          status: string;
        }[];
        version: number;
        revision: number;
        versions: { terms: unknown }[];
        zipDeliveries?: { id: string; milestone_id: string }[];
      }
    | undefined;
  const clear = () => {
    current = undefined;
    el("snapshot").textContent = "";
    (el("terms") as HTMLInputElement).value = "";
    (el("confirmed") as HTMLInputElement).checked = false;
  };
  el("contract").addEventListener("input", clear);
  const send = async (path: string, body?: unknown) => {
    current = await apiRequest(
      "/api/contracts" + path,
      body ? "POST" : "GET",
      body
    );
    (el("contract") as HTMLInputElement).value = current!.id;
    el("snapshot").textContent = JSON.stringify(current, null, 2);
    (el("terms") as HTMLInputElement).value = JSON.stringify(
      current!.versions.at(-1)!.terms,
      null,
      2
    );
    el("milestone").replaceChildren();
    for (const m of current!.milestones.filter(
      m => m.version === current!.version
    )) {
      const option = root.createElement("option");
      option.value = m.id;
      option.textContent =
        m.title + " · " + (m.status === "accepted" ? "甲方已验收" : m.status);
      el("milestone").append(option);
    }
    const workspace = el("workspace") as HTMLAnchorElement;
    workspace.hidden = current!.status !== "active";
    workspace.href = "/workspaces?contract=" + encodeURIComponent(current!.id);
    (el("confirmed") as HTMLInputElement).checked = false;
    el("status").textContent =
      "已保存 / 已读取。验收报告草稿不代表甲方最终确认。";
  };
  const bind = (id: string, fn: () => Promise<void>) =>
    el(id).addEventListener("click", () => {
      void fn().catch(e => {
        if (el("status")) el("status").textContent = "操作未完成：" + e.message;
      });
    });
  void apiRequest("/api/contracts")
    .then(rows => {
      for (const row of rows) {
        const button = root.createElement("button");
        button.textContent = `${row.party === "buyer" ? "甲方" : "乙方"} · ${
          row.versions.at(-1).terms.scope
        } · ${row.status}`;
        button.addEventListener("click", () => {
          void send("/" + encodeURIComponent(row.id)).catch(e => {
            el("status").textContent = e.message;
          });
        });
        el("orders").append(button);
      }
      if (!rows.length) el("orders").textContent = "暂无可访问的合同";
    })
    .catch(e => {
      el("status").textContent = e.message;
    });
  void apiRequest("/api/contracts/bids")
    .then(rows => {
      for (const row of rows) {
        const link = root.createElement("a");
        link.textContent = row.proposal.summary + " · " + row.status;
        link.href =
          "/market?task=" +
          encodeURIComponent(row.requirement_id) +
          "&bid=" +
          encodeURIComponent(row.id);
        el("my-bids").append(link);
      }
    })
    .catch(e => {
      el("status").textContent = e.message;
    });
  const linked =
    typeof location !== "undefined"
      ? new URLSearchParams(location.search).get("contract")
      : null;
  if (linked)
    void send("/" + encodeURIComponent(linked)).catch(e => {
      el("status").textContent = e.message;
    });
  bind("load", () => send("/" + encodeURIComponent(val("contract"))));
  bind("select", () =>
    send("/select", {
      bidId: val("bid"),
      confirmed: (el("confirmed") as HTMLInputElement).checked
    })
  );
  for (const [button, action] of Object.entries({
    transition: "transition",
    confirm: "confirm",
    change: "change",
    "milestone-action": "milestone",
    review: "review_draft",
    settlement: "settlement"
  }))
    bind(button, async () => {
      if (!current) throw new Error("请先读取合同");
      await send("/" + encodeURIComponent(current.id) + "/commands", {
        action,
        version: current.version,
        revision: current.revision,
        requestKey: crypto.randomUUID(),
        confirmed: (el("confirmed") as HTMLInputElement).checked,
        reason: { code: val("reason-code"), detail: val("reason-detail") },
        ...(action === "change" ? { terms: JSON.parse(val("terms")) } : {}),
        to: val("target"),
        milestoneId: val("milestone"),
        deliveryId: current.zipDeliveries
          ?.filter(d => d.milestone_id === val("milestone"))
          .at(-1)?.id,
        report: val("evidence")
      });
    });
}
if (typeof document !== "undefined") mountContracts();
