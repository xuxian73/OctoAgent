import { renderFiles, mountFiles } from "./files.js";
import { apiRequest } from "./client.js";
export function renderWorkspaces() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付证据 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付工作区</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>真实本地 Git，仓库由部署配置隔离保存。检查由独立隔离执行器运行；未配置运行时或镜像会阻塞，不连接远端或创建 PR。历史模拟记录仅供查看。</p><label>合同<select id="contract"></select></label><button id="load">读取交付证据</button><p id="status" role="status"></p><section id="authorization"><h2>显式接单授权</h2><p>本人操作与 Agent 委托分别授权；每项最长 15 分钟。注册、报价、签约均不授予仓库写权限。Agent 还需要责任主体在“我的 Agent”签发对应合同 scope 的短期凭据。</p><form id="grant-form"><label>授权对象<select id="actor"></select></label><label>独立权限<select id="permission"><option value="branch">创建分支</option><option value="commit">提交代码</option><option value="check">运行检查</option><option value="pull_request">创建 PR</option><option value="artifact">上传制品</option><option value="submit">提交里程碑</option><option value="discussion">讨论/阻塞</option><option value="delegate">允许所选责任主体委托 Agent（独立开关）</option></select></label><label>有效期（秒；0 为撤销）<input id="ttl" type="number" min="0" max="900" required value="300"></label><label><input id="grant-confirmed" type="checkbox" required>本人作为合同甲方，确认对象、独立权限和有效期</label><button type="submit">确认授权 / 撤销</button></form></section><h2>当前分项授权与到期时间</h2><pre id="permissions"></pre><section id="git-controls"><h2>真实本地 Git</h2><button id="git-init">初始化仓库</button><form id="branch-form"><label>新分支名称<input id="git-branch" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"></label><button>从 main 创建分支</button></form><button id="source-refresh">刷新可导入制品</button><form id="import-form"><label>目标分支<select id="target-branch" required></select></label><label>已放行的当前版本制品<select id="source-file" required></select></label><label>仓库内相对路径<input id="target-path" required placeholder="src/main.ts"></label><label>提交摘要<input id="git-summary" required></label><button>导入单个制品并提交</button></form></section><h2>真实 diff</h2><pre id="diffs"></pre><h2>分支</h2><pre id="branches"></pre><h2>变更摘要与提交</h2><pre id="commits"></pre><h2>隔离检查</h2><form id="check-form"><label>提交<select id="check-sha" required></select></label><label>检查类型<select id="check-kind"><option value="test">测试</option><option value="typecheck">类型检查</option></select></label><button>排队检查</button></form><form id="cancel-check-form"><label>待完成检查<select id="cancel-check-id" required></select></label><button>取消检查</button></form><p>刷新交付证据查看结果。queued/running 不代表通过；历史成功仅属于其 SHA 与合同版本。</p><h2>检查日志</h2><pre id="checks"></pre><h2>PR</h2><pre id="pullRequests"></pre><h2>制品 checksum</h2><pre id="artifacts"></pre><h2>里程碑证据与预览地址</h2><pre id="submissions"></pre><h2>未解决风险</h2><pre id="risks"></pre><h2>部署与确认请求（未执行）</h2><pre id="deployments"></pre><h2>任务版本、讨论和审计引用</h2><pre id="context"></pre><label>源制品所属里程碑<select id="file-milestone"></select></label><p>上传源制品后等待扫描放行，再刷新可导入制品。提交 SHA 由 Git 生成。</p>${renderFiles()}</main><script type="module" src="/workspaces.js"></script></body></html>`;
}
export function mountWorkspaces(root: Document = document) {
  const el = (id: string) => root.getElementById(id)!;
  const value = (id: string) => (el(id) as HTMLInputElement).value;
  const sections = [
    "diffs",
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
    sha: ""
  }));
  let generation = 0;
  const clear = () => {
    generation++;
    version = 0;
    el("authorization").hidden = true;
    el("git-controls").hidden = true;
    for (const id of ["target-branch", "source-file", "file-milestone"])
      el(id).replaceChildren();
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
        el("git-controls").hidden =
          data.party !== "seller" ||
          data.status !== "active" ||
          data.provider === "offline-fake";
        el("target-branch").replaceChildren();
        for (const branch of Object.keys(data.branches).filter(
          b => b !== "main"
        )) {
          const option = root.createElement("option");
          option.value = branch;
          option.textContent = branch;
          el("target-branch").append(option);
        }
        el("check-sha").replaceChildren();
        for (const commit of data.commits) {
          const option = root.createElement("option");
          option.value = commit.sha;
          option.textContent = commit.summary + " · " + commit.sha;
          el("check-sha").append(option);
        }
        el("cancel-check-id").replaceChildren();
        for (const check of data.checks.filter((c: { status: string }) =>
          ["queued", "running"].includes(c.status)
        )) {
          const option = root.createElement("option");
          option.value = check.id;
          option.textContent = check.kind + " · " + check.sha;
          el("cancel-check-id").append(option);
        }
        el("file-milestone").replaceChildren();
        for (const milestone of data.milestones.filter(
          (m: { version: number }) => m.version === version
        )) {
          const option = root.createElement("option");
          option.value = milestone.id;
          option.textContent = milestone.title;
          el("file-milestone").append(option);
        }
        void refreshSources();
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
        el("status").textContent =
          ({
            "local-git": "真实本地 Git",
            "offline-fake": "历史模拟仓库（不可迁移）",
            uninitialized: "未初始化"
          } as Record<string, string>)[data.provider] +
          " · 当前合同状态：" +
          result.data.status;
      })
      .catch(e => {
        if (current === generation && el("status"))
          el("status").textContent = "读取失败：" + e.message;
      });
  });
  async function refreshSources() {
    const current = generation;
    try {
      const files = await apiRequest(
        `/api/files?kind=artifact&resourceId=${encodeURIComponent(
          value("contract")
        )}`
      );
      if (current !== generation) return;
      el("source-file").replaceChildren();
      for (const file of files.filter(
        (f: {
          version: number;
          scan_status: string;
          simulated: boolean;
          scan_checksum: string;
          checksum: string;
        }) =>
          f.version === version &&
          f.scan_status === "clean" &&
          !f.simulated &&
          f.scan_checksum === f.checksum
      )) {
        const option = root.createElement("option");
        option.value = file.id;
        option.textContent = file.name + " · " + file.checksum;
        el("source-file").append(option);
      }
    } catch (e) {
      if (current === generation) el("status").textContent = String(e);
    }
  }
  // Preserve the key after a lost response; identical retries must not create another commit.
  let pending: { fingerprint: string; requestKey: string } | undefined;
  async function gitCommand(
    action: string,
    fields: Record<string, unknown> = {}
  ) {
    const contract = value("contract");
    const current = generation;
    const body = { action, version, ...fields };
    const fingerprint = JSON.stringify([contract, body]);
    if (!pending || pending.fingerprint !== fingerprint)
      pending = { fingerprint, requestKey: crypto.randomUUID() };
    try {
      await apiRequest(
        `/api/workspaces/${encodeURIComponent(contract)}/commands`,
        "POST",
        { ...body, requestKey: pending.requestKey }
      );
      pending = undefined;
      if (current === generation) el("load").click();
    } catch (e) {
      if (current === generation)
        el("status").textContent = "操作未完成：" + String(e);
    }
  }
  el("check-form").addEventListener("submit", event => {
    event.preventDefault();
    void gitCommand("run_check", {
      sha: value("check-sha"),
      kind: value("check-kind")
    });
  });
  el("cancel-check-form").addEventListener("submit", event => {
    event.preventDefault();
    void gitCommand("cancel_check", { checkId: value("cancel-check-id") });
  });
  el("git-init").addEventListener(
    "click",
    () => void gitCommand("initialize_repository")
  );
  el("source-refresh").addEventListener("click", () => void refreshSources());
  el("branch-form").addEventListener("submit", event => {
    event.preventDefault();
    void gitCommand("create_workspace_branch", { branch: value("git-branch") });
  });
  el("import-form").addEventListener("submit", event => {
    event.preventDefault();
    void gitCommand("import_artifact", {
      branch: value("target-branch"),
      fileId: value("source-file"),
      path: value("target-path"),
      summary: value("git-summary")
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
