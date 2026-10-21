export function renderContracts() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合同与验收 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>合同与里程碑</h1><a href="/workspaces">交付工作区</a><a href="/market">返回报价</a><p>双方确认后合同才生效。范围变更生成新版本并重新确认。争议冻结后续推进。结算仅记账，不执行支付。</p><label>会话凭据<input id="session" type="password" autocomplete="off"></label><label>选定报价 ID<input id="bid"></label><button id="select">确认选择报价并生成草案</button><label>合同 ID<input id="contract"></label><button id="load">读取合同</button><pre id="snapshot"></pre><label>当前版本条款（变更时编辑 JSON，里程碑每版重新验收）<textarea id="terms" rows="12"></textarea></label><label>里程碑 ID<input id="milestone"></label><label>目标状态<select id="target">${[
    "pending_confirmation",
    "active",
    "paused",
    "completed",
    "cancelled",
    "disputed",
    "in_progress",
    "submitted",
    "changes_requested",
    "accepted",
    "rejected"
  ]
    .map(s => `<option>${s}</option>`)
    .join(
      ""
    )}</select></label><label>原因类别<input id="reason-code"></label><label>原因说明<textarea id="reason-detail"></textarea></label><label>交付证据或验收报告草稿<textarea id="evidence"></textarea></label><label><input id="confirmed" type="checkbox">我已阅读当前版本、影响对象和原因，人工确认本次操作</label><button id="transition">更新合同状态 / 发起争议</button><button id="confirm">代表本方确认当前版本</button><button id="change">提出新范围版本</button><button id="milestone-action">更新里程碑 / 验收 / 要求修改</button><button id="review">仅保存验收报告草稿（不验收）</button><button id="settlement">人工确认结算记录</button><p id="status" role="status"></p></main><script type="module" src="/contracts.js"></script></body></html>`;
}
export function mountContracts(root: Document = document) {
  const el = (id: string) => root.getElementById(id)!;
  const val = (id: string) => (el(id) as HTMLInputElement).value;
  let current:
    | {
        id: string;
        version: number;
        revision: number;
        versions: { terms: unknown }[];
      }
    | undefined;
  const clear = () => {
    current = undefined;
    el("snapshot").textContent = "";
    (el("terms") as HTMLInputElement).value = "";
    (el("confirmed") as HTMLInputElement).checked = false;
  };
  el("session").addEventListener("input", clear);
  el("contract").addEventListener("input", clear);
  const send = async (path: string, body?: unknown) => {
    const session = val("session");
    const result = await fetch("/api/contracts" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + session,
        "Content-Type": "application/json"
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }).then(r => r.json());
    if (session !== val("session")) return;
    if (!result.ok) throw new Error(result.error.code);
    current = result.data;
    (el("contract") as HTMLInputElement).value = current!.id;
    el("snapshot").textContent = JSON.stringify(current, null, 2);
    (el("terms") as HTMLInputElement).value = JSON.stringify(
      current!.versions.at(-1)!.terms,
      null,
      2
    );
    (el("confirmed") as HTMLInputElement).checked = false;
    el("status").textContent =
      "已保存 / 已读取。验收报告草稿不代表甲方最终确认。";
  };
  const bind = (id: string, fn: () => Promise<void>) =>
    el(id).addEventListener("click", () => {
      void fn().catch(e => {
        el("status").textContent = "操作未完成：" + e.message;
      });
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
        evidence: val("evidence"),
        report: val("evidence")
      });
    });
}
if (typeof document !== "undefined") mountContracts();
