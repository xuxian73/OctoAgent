import { apiRequest } from "./client.js";
export function renderWorkspaces() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付证据 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付工作区</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>离线模拟 GitHub。检查不执行仓库代码。生产操作关闭，确认请求不会执行部署。</p><label>合同 ID<input id="contract"></label><button id="load">读取交付证据</button><p id="status" role="status"></p><h2>变更摘要、分支与提交</h2><pre id="commits"></pre><h2>检查日志</h2><pre id="checks"></pre><h2>PR</h2><pre id="pullRequests"></pre><h2>制品 checksum</h2><pre id="artifacts"></pre><h2>里程碑证据与预览地址</h2><pre id="submissions"></pre><h2>未解决风险</h2><pre id="risks"></pre><h2>部署与确认请求（未执行）</h2><pre id="deployments"></pre><h2>任务版本、讨论和审计引用</h2><pre id="context"></pre></main><script type="module" src="/workspaces.js"></script></body></html>`;
}
export function mountWorkspaces(root: Document = document) {
  const el = (id: string) => root.getElementById(id)!;
  const value = (id: string) => (el(id) as HTMLInputElement).value;
  const sections = [
    "commits",
    "checks",
    "pullRequests",
    "artifacts",
    "submissions",
    "risks",
    "deployments",
    "context"
  ];
  let generation = 0;
  const clear = () => {
    generation++;
    for (const id of [...sections, "status"]) el(id).textContent = "";
  };
  for (const id of ["contract"]) el(id).addEventListener("input", clear);
  el("load").addEventListener("click", () => {
    clear();
    const current = generation;
    void apiRequest("/api/workspaces/" + encodeURIComponent(value("contract")))
      .then(data => {
        if (current !== generation) return;
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
}
if (typeof document !== "undefined") mountWorkspaces();
