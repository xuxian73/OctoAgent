import { renderFiles, mountFiles } from "./files.js";
import { apiRequest } from "./client.js";
export function renderWorkspaces() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付证据 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付工作区</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>离线模拟 GitHub。检查不执行仓库代码。生产操作关闭，确认请求不会执行部署。</p><label>合同<select id="contract"></select></label><button id="load">读取交付证据</button><p id="status" role="status"></p><section id="authorization"><h2>显式接单授权</h2><p>本人操作与 Agent 委托分别授权；每项最长 15 分钟。注册、报价、签约均不授予仓库写权限。Agent 还需要责任主体在“我的 Agent”签发对应合同 scope 的短期凭据。</p><form id="grant-form"><label>授权对象<select id="actor"></select></label><label>独立权限<select id="permission"><option value="branch">创建分支</option><option value="commit">提交代码</option><option value="check">运行检查</option><option value="pull_request">创建 PR</option><option value="artifact">上传制品</option><option value="submit">提交里程碑</option><option value="discussion">讨论/阻塞</option><option value="delegate">允许所选责任主体委托 Agent（独立开关）</option></select></label><label>有效期（秒；0 为撤销）<input id="ttl" type="number" min="0" max="900" required value="300"></label><label><input id="grant-confirmed" type="checkbox" required>本人作为合同甲方，确认对象、独立权限和有效期</label><button type="submit">确认授权 / 撤销</button></form></section><h2>当前分项授权与到期时间</h2><pre id="permissions"></pre><h2>分支</h2><pre id="branches"></pre><h2>变更摘要与提交</h2><pre id="commits"></pre><h2>检查日志</h2><pre id="checks"></pre><h2>PR</h2><pre id="pullRequests"></pre><h2>制品 checksum</h2><pre id="artifacts"></pre><h2>里程碑证据与预览地址</h2><pre id="submissions"></pre><h2>未解决风险</h2><pre id="risks"></pre><h2>部署与确认请求（未执行）</h2><pre id="deployments"></pre><h2>任务版本、讨论和审计引用</h2><pre id="context"></pre><label>制品里程碑 ID<input id="file-milestone"></label><label>制品提交 SHA<input id="file-sha"></label>${renderFiles()}</main><script type="module" src="/workspaces.js"></script></body></html>`;
}
export function mountWorkspaces(root: Document = document) {
  const el = (id: string) => root.getElementById(id)!;
  const value = (id: string) => (el(id) as HTMLInputElement).value;
  const sections = [
    "branches",
    "permissions",
    "commits",
    "checks",
    "pullRequests",
    "artifacts",
    "submissions",
    "risks",
    "deployments",
    "context"
  ];
  let version = 0;
  mountFiles(root, () => ({
    kind: "artifact",
    resourceId: value("contract"),
    version,
    revision: 0,
    milestoneId: value("file-milestone"),
    sha: value("file-sha")
  }));
  let generation = 0;
  const clear = () => {
    generation++;
    version = 0;
    el("authorization").hidden = true;
    for (const id of [...sections, "status"]) el(id).textContent = "";
  };
  for (const id of ["contract"]) el(id).addEventListener("input", clear);
  el("load").addEventListener("click", () => {
    clear();
    const current = generation;
    void apiRequest("/api/workspaces/" + encodeURIComponent(value("contract")))
      .then(data => {
        if (current !== generation) return;
        version = data.version;
        el("authorization").hidden = data.party !== "buyer";
        el("actor").replaceChildren();
        for (const actor of data.actors) {
          const option = root.createElement("option");
          option.value = actor.id;
          option.textContent = actor.label;
          el("actor").append(option);
        }
        const result = { data };
        for (const id of sections)
          el(id).textContent = JSON.stringify(
            id === "context"
              ? {
                  taskVersion: result.data.taskVersion,
                  version: result.data.version,
                  discussions: result.data.discussions,
                  auditEventReferences: result.data.auditEventReferences
                }
              : id === "permissions"
              ? result.data.permissions.map(
                  (p: {
                    actor_id: string;
                    permission: string;
                    expires_at: number | null;
                  }) => ({
                    对象: p.actor_id,
                    权限: p.permission,
                    有效期:
                      p.expires_at === null
                        ? "历史长期授权，可显式撤销"
                        : new Date(p.expires_at).toLocaleString(),
                    状态:
                      p.expires_at === null || p.expires_at > Date.now()
                        ? "有效"
                        : "已过期或撤销"
                  })
                )
              : result.data[id],
            null,
            2
          );
        el("status").textContent = "当前合同状态：" + result.data.status;
      })
      .catch(() => {
        if (current === generation && el("status"))
          el("status").textContent = "读取失败，请检查权限和合同 ID。";
      });
  });
  el("grant-form").addEventListener("submit", event => {
    event.preventDefault();
    void apiRequest(
      "/api/workspaces/" + encodeURIComponent(value("contract")) + "/commands",
      "POST",
      {
        action: "authorize",
        version,
        requestKey: crypto.randomUUID(),
        actorId: value("actor"),
        permission: value("permission"),
        ttlMs: Number(value("ttl")) * 1000,
        confirmed: (el("grant-confirmed") as HTMLInputElement).checked
      }
    )
      .then(() => {
        (el("grant-confirmed") as HTMLInputElement).checked = false;
        el("load").click();
      })
      .catch(e => {
        el("status").textContent = "授权未完成：" + e.message;
      });
  });
  void apiRequest("/api/contracts")
    .then(rows => {
      for (const row of rows) {
        const option = root.createElement("option");
        option.value = row.id;
        option.textContent =
          row.versions.at(-1).terms.scope + " · " + row.status;
        el("contract").append(option);
      }
      const linked =
        typeof location !== "undefined"
          ? new URLSearchParams(location.search).get("contract")
          : null;
      if (linked) (el("contract") as HTMLSelectElement).value = linked;
      if (value("contract")) el("load").click();
    })
    .catch(e => {
      el("status").textContent = e.message;
    });
}
if (typeof document !== "undefined") mountWorkspaces();
