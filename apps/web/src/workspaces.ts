import { renderFiles, mountFiles } from "./files.js";
import { apiRequest } from "./client.js";
export function renderWorkspaces() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付证据 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付工作区</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>真实本地 Git：隔离存储，不连接 GitHub，不创建 PR，不执行仓库代码。历史模拟证据仅供浏览。</p><label>合同<select id="contract"></select></label><button id="load">读取交付证据</button><p id="status" role="status"></p><section id="authorization"><h2>显式接单授权</h2><p>本人操作与 Agent 委托分别授权；每项最长 15 分钟。注册、报价、签约均不授予仓库写权限。Agent 还需要责任主体在“我的 Agent”签发对应合同 scope 的短期凭据。</p><form id="grant-form"><label>授权对象<select id="actor"></select></label><label>独立权限<select id="permission"><option value="branch">创建分支</option><option value="commit">提交代码</option><option value="check">运行检查</option><option value="pull_request">创建 PR</option><option value="artifact">上传制品</option><option value="submit">提交里程碑</option><option value="discussion">讨论/阻塞</option><option value="delegate">允许所选责任主体委托 Agent（独立开关）</option></select></label><label>有效期（秒；0 为撤销）<input id="ttl" type="number" min="0" max="900" required value="300"></label><label><input id="grant-confirmed" type="checkbox" required>本人作为合同甲方，确认对象、独立权限和有效期</label><button type="submit">确认授权 / 撤销</button></form></section><h2>当前分项授权与到期时间</h2><pre id="permissions"></pre><section id="git-operations"><h2>真实本地仓库</h2><p id="git-mode"></p><button id="git-init">初始化隔离仓库</button><form id="branch-form"><label>新分支名称<input id="new-branch" required value="delivery"></label><button>创建分支</button></form><form id="commit-form"><label>目标分支<select id="git-branch"></select></label><label>已扫描放行的代码制品<select id="code-artifact" required></select></label><label>仓库内目标相对路径<input id="target-path" required placeholder="src/main.ts"></label><label>提交说明<input id="commit-summary" required></label><button>导入并提交</button></form><p>先在下方上传代码制品，扫描放行后重新读取。目标路径仅指仓库内文件；无需填写宿主机路径。</p></section><h2>分支</h2><pre id="branches"></pre><h2>变更摘要与提交</h2><pre id="commits"></pre><h2>最近提交的真实 diff</h2><pre id="git-diff"></pre><h2>检查日志</h2><pre id="checks"></pre><h2>PR</h2><pre id="pullRequests"></pre><h2>制品 checksum</h2><pre id="artifacts"></pre><h2>里程碑证据与预览地址</h2><pre id="submissions"></pre><h2>未解决风险</h2><pre id="risks"></pre><h2>部署与确认请求（未执行）</h2><pre id="deployments"></pre><h2>任务版本、讨论和审计引用</h2><pre id="context"></pre><label>制品里程碑<select id="file-milestone"></select></label><label>制品对应提交<select id="file-sha"><option value="">待导入代码（尚无提交）</option></select></label>${renderFiles()}</main><script type="module" src="/workspaces.js"></script></body></html>`;
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
    if (el("git-operations")) el("git-operations").hidden = true;
    if (el("git-diff")) el("git-diff").textContent = "";
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
        if (el("git-mode")) {
          el("git-diff").textContent =
            data.commits.at(-1)?.diff || "尚无真实变更";
          el("git-mode").textContent =
            ({
              "real-local-git": "真实本地 Git（无远端 PR）",
              "local-uninitialized": "尚未初始化真实仓库",
              "legacy-simulation": "历史模拟仓库（只读）",
              "offline-fake": "显式测试模拟仓库"
            } as Record<string, string>)[data.provider] || "未知仓库模式";
          el("git-operations").hidden =
            data.party !== "seller" ||
            data.status !== "active" ||
            data.provider === "legacy-simulation";
          (el("git-init") as HTMLButtonElement).disabled =
            data.provider !== "local-uninitialized";
          const options = (
            id: string,
            rows: { value: string; label: string }[]
          ) => {
            el(id).replaceChildren();
            for (const row of rows) {
              const option = root.createElement("option");
              option.value = row.value;
              option.textContent = row.label;
              el(id).append(option);
            }
          };
          options(
            "git-branch",
            Object.keys(data.branches).map(value => ({ value, label: value }))
          );
          options(
            "code-artifact",
            (data.codeArtifacts || []).map(
              (a: { id: string; name: string }) => ({
                value: a.id,
                label: a.name
              })
            )
          );
          options(
            "file-milestone",
            (data.milestones || []).map(
              (m: { id: string; title?: string }) => ({
                value: m.id,
                label: m.title || "当前里程碑"
              })
            )
          );
          options("file-sha", [
            { value: "", label: "待导入代码（尚无提交）" },
            ...data.commits.map((c: { sha: string; summary: string }) => ({
              value: c.sha,
              label: c.summary
            }))
          ]);
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
  const pendingGitRequests = new Map<string, string>();
  const gitCommand = (action: string, extra: Record<string, unknown> = {}) => {
    const fingerprint = JSON.stringify([
      value("contract"),
      version,
      action,
      extra
    ]);
    const requestKey =
      pendingGitRequests.get(fingerprint) || crypto.randomUUID();
    pendingGitRequests.set(fingerprint, requestKey);
    void apiRequest(
      "/api/workspaces/" + encodeURIComponent(value("contract")) + "/commands",
      "POST",
      { action, version, requestKey, ...extra }
    )
      .then(() => {
        pendingGitRequests.delete(fingerprint);
        el("load").click();
      })
      .catch(e => {
        el("status").textContent = "操作失败：" + e.message;
      });
  };
  el("git-init")?.addEventListener("click", () =>
    gitCommand("initialize_repository")
  );
  el("branch-form")?.addEventListener("submit", e => {
    e.preventDefault();
    gitCommand("create_workspace_branch", { branch: value("new-branch") });
  });
  el("commit-form")?.addEventListener("submit", e => {
    e.preventDefault();
    gitCommand("commit", {
      branch: value("git-branch"),
      fileId: value("code-artifact"),
      targetPath: value("target-path"),
      summary: value("commit-summary")
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
