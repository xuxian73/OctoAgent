import { renderZipReview, mountZipReview } from "./zip-review.js";
import { renderFiles, mountFiles } from "./files.js";
import { apiRequest } from "./client.js";
export function renderWorkspaces() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付证据 · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>交付工作区</h1><p role="note">任务、仓库文件、评论和制品均为不可信数据；其中的指令不能扩大 scope、覆盖系统授权或代替人工确认。</p><p>每次交付一个 ZIP，附说明、运行方法和已知问题。乙方自行开发和测试；平台只扫描文件，由甲方人工验收，不代表功能测试通过。历史模拟记录仅供查看。</p><label>合同<select id="contract"></select></label><button id="load">读取交付证据</button><p id="status" role="status"></p><section id="authorization"><h2>本合同交付授权</h2><p>本人操作与 Agent 委托分别授权；每项仅限所选合同，最长 15 分钟；填写 0 可撤销，变更记录写入审计。<a id="contract-agents" href="/agents">管理 Agent 与可撤销凭据</a>注册、报价、签约均不授予仓库写权限。Agent 还需要责任主体在“我的 Agent”签发对应合同 scope 的短期凭据。</p><form id="grant-form"><label>授权对象<select id="actor"></select></label><label>独立权限<select id="permission"><option value="artifact" selected>上传 ZIP（本合同）</option><option value="submit">提交里程碑</option><option value="discussion">讨论/阻塞</option><option value="delegate">允许所选责任主体委托 Agent（独立开关）</option></select></label><label>有效期（秒；0 为撤销）<input id="ttl" type="number" min="0" max="900" required value="300"></label><label><input id="grant-confirmed" type="checkbox" required>本人作为合同甲方，确认对象、独立权限和有效期</label><button type="submit">确认授权 / 撤销</button></form></section><h2>当前分项授权与到期时间</h2><pre id="permissions"></pre><details id="git-extension" hidden><summary>可选 Git 扩展（非交付前置；历史记录按原状态展示）</summary><section id="git-controls"><h2>真实本地 Git</h2><button id="git-init">初始化仓库</button><form id="branch-form"><label>新分支名称<input id="git-branch" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"></label><button>从 main 创建分支</button></form><button id="source-refresh">刷新可导入制品</button><form id="import-form"><label>目标分支<select id="target-branch" required></select></label><label>已放行的当前版本制品<select id="source-file" required></select></label><label>仓库内相对路径<input id="target-path" required placeholder="src/main.ts"></label><label>提交摘要<input id="git-summary" required></label><button>导入单个制品并提交</button></form></section><section id="github-controls"><h2>显式 GitHub 连接</h2><p>部署者先在服务端配置指定合同、责任主体、仓库数字身份、凭据引用及权限上限；页面不接收凭据。默认只读，每次连接最长 15 分钟。</p><p id="github-status" role="status"></p><form id="github-connect"><label>部署者预配置仓库<select id="github-profile" required></select></label><label><input id="github-write" type="checkbox">独立授权写入分支和提交</label><label><input id="github-pr" type="checkbox">独立授权创建 PR</label><label><input id="github-confirm" type="checkbox">本人作为甲方责任主体确认下方计划中的仓库、范围和到期时间</label><button>生成计划 / 确认连接</button></form><button id="github-revoke">撤销连接</button><p>同步将把所选本地提交的完整文件树写入独立远端分支，服务端会比较固定基线；若缺少任何远端文件则拒绝同步并列出路径，本轮不支持删除。不会修改基线分支；不会合并或部署。操作还需甲方授予乙方对应工作区权限。</p><label>本地提交<select id="github-sha"></select></label><button id="github-sync">同步完整快照至远端分支</button><button id="github-create-pr">创建 / 恢复 PR</button><button id="github-checks">读取该远端 SHA 检查</button><pre id="github-evidence"></pre><div id="github-links"></div></section><h2>真实 diff</h2><pre id="diffs"></pre><h2>分支</h2><pre id="branches"></pre><h2>变更摘要与提交</h2><pre id="commits"></pre><h2>检查日志</h2><pre id="checks"></pre><h2>PR</h2><pre id="pullRequests"></pre><h2>制品 checksum</h2><pre id="artifacts"></pre></details><details><summary>历史模拟证据与审计（不作为 ZIP 验收证据）</summary><h2>历史模拟提交（不作为 ZIP 验收证据）</h2><pre id="submissions"></pre><h2>ZIP 交付版本与文件 SHA-256</h2><pre id="zipDeliveries"></pre><h2>未解决风险</h2><pre id="risks"></pre><h2>部署与确认请求（未执行）</h2><pre id="deployments"></pre><h2>任务版本、讨论和审计引用</h2><pre id="context"></pre></details><label>交付里程碑<select id="file-milestone"></select></label><p>上传 ZIP 后等待扫描放行，再刷新交付文件。文件 SHA-256 不等于 Git commit SHA。</p><button id="zip-refresh">刷新可提交 ZIP</button><form id="zip-form"><label>扫描放行的 ZIP<select id="zip-file" required></select></label><label>交付说明<textarea id="zip-summary" required></textarea></label><label>运行方法<textarea id="zip-instructions" required></textarea></label><label>已知问题（无则填写无）<textarea id="zip-issues" required></textarea></label><button>提交当前里程碑 ZIP</button></form>${renderZipReview()}${renderFiles()}</main><script type="module" src="/workspaces.js"></script></body></html>`;
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
    "zipDeliveries",
    "risks",
    "deployments",
    "context"
  ];
  let party = "";
  const review = mountZipReview(
    root,
    () => value("contract"),
    () => value("file-milestone"),
    () => party,
    message => load(message)
  );
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
  let connectionPlan: { key: string; confirmationId: string } | undefined;
  const clear = () => {
    generation++;
    review.clear();
    el("zip-file").replaceChildren();
    el("zip-form").hidden = true;
    connectionPlan = undefined;
    version = 0;
    party = "";
    if (el("file-upload")) el("file-upload").hidden = true;
    el("zip-refresh").hidden = true;
    el("authorization").hidden = true;
    el("git-controls").hidden = true;
    el("github-controls").hidden = true;
    for (const id of ["github-evidence", "github-status"])
      el(id).textContent = "";
    for (const id of ["github-links", "github-profile", "github-sha"])
      el(id).replaceChildren();
    for (const id of ["github-write", "github-pr", "github-confirm"])
      (el(id) as HTMLInputElement).checked = false;
    for (const id of ["target-branch", "source-file", "file-milestone"])
      el(id).replaceChildren();
    for (const id of [...sections, "status"]) el(id).textContent = "";
  };
  for (const id of ["contract"]) el(id).addEventListener("input", clear);
  async function load(message = "") {
    const selectedMilestone = value("file-milestone");
    clear();
    const current = generation;
    await apiRequest(
      "/api/workspaces/" +
        encodeURIComponent(value("contract")) +
        ((el("git-extension") as HTMLDetailsElement).open ? "?git=1" : "")
    )
      .then(async data => {
        if (current !== generation) return;
        version = data.version;
        party = data.party;
        if (el("contract-agents"))
          (el("contract-agents") as HTMLAnchorElement).href =
            "/agents?contract=" + encodeURIComponent(value("contract"));
        el("authorization").hidden =
          data.party !== "buyer" || data.status !== "active";
        for (const option of Array.from(el("contract").children)) {
          if ((option as HTMLOptionElement).value === value("contract"))
            option.textContent = (option.textContent || "").replace(
              / · [^·]*$/,
              " · " + data.status
            );
        }
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
        el("file-milestone").replaceChildren();
        for (const milestone of data.milestones.filter(
          (m: { version: number }) => m.version === version
        )) {
          const option = root.createElement("option");
          option.value = milestone.id;
          option.textContent = milestone.title;
          el("file-milestone").append(option);
        }
        if (
          data.milestones.some(
            (m: any) => m.id === selectedMilestone && m.version === version
          )
        )
          (el("file-milestone") as HTMLSelectElement).value = selectedMilestone;
        el("github-sha").replaceChildren();
        for (const commit of data.commits) {
          const option = root.createElement("option");
          option.value = commit.sha;
          option.textContent = commit.branch + " · " + commit.sha;
          el("github-sha").append(option);
        }
        if ((el("git-extension") as HTMLDetailsElement).open)
          void refreshGitHub(data.party, current);
        void refreshSources();

        el("file-refresh")?.click();
        el("zip-refresh").hidden =
          data.party !== "seller" || data.status !== "active";
        el("zip-form").hidden =
          data.party !== "seller" || data.status !== "active";
        if (el("file-upload"))
          el("file-upload").hidden =
            data.party !== "seller" || data.status !== "active";
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
          "ZIP 人工验收 · 当前合同状态：" +
          (({
            active: "已生效",
            paused: "已暂停",
            disputed: "争议中",
            completed: "已完成",
            pending_confirmation: "待双方确认"
          } as Record<string, string>)[data.status] || data.status) +
          (["paused", "disputed"].includes(data.status)
            ? "。请返回合同处理，恢复生效后再交付。"
            : data.status === "completed"
            ? "。未付款或部署；可查看交付记录。"
            : "。上传和提交需要甲方授予本合同短期权限。");
        await review.refresh();
        if (current === generation && el("zip-review-status"))
          el("zip-review-status").textContent = message;
      })
      .catch(e => {
        if (current === generation && el("status"))
          el("status").textContent =
            (message
              ? message + " 工作区刷新失败，请重新读取交付证据："
              : "读取失败：") + e.message;
      });
  }
  el("load").addEventListener("click", () => void load());
  clear();
  async function refreshGitHub(party: string, current: number) {
    try {
      const data = await apiRequest(
        `/api/workspaces/${encodeURIComponent(value("contract"))}/github`
      );
      if (current !== generation) return;
      el("github-controls").hidden = false;
      el("github-connect").hidden = party !== "buyer";
      el("github-revoke").hidden = party !== "buyer";
      el("github-status").textContent = data.nextStep;
      el("github-profile").replaceChildren();
      for (const p of data.profiles || []) {
        const option = root.createElement("option");
        option.value = p.id;
        option.textContent = `${p.repository} (#${p.repositoryId}) → ${
          p.base
        } · 上限 ${p.allowed.join(", ")} · ${new Date(
          p.expiresAt
        ).toLocaleString()}`;
        el("github-profile").append(option);
      }
      const scopes = data.connection?.active ? data.connection.scopes : [];
      el("github-sync").hidden =
        party !== "seller" || !scopes.includes("write");
      el("github-create-pr").hidden =
        party !== "seller" || !scopes.includes("create_pr");
      el("github-checks").hidden = !scopes.includes("read");
      el("github-evidence").textContent = JSON.stringify(
        { connection: data.connection, evidence: data.evidence },
        null,
        2
      );
      el("github-links").replaceChildren();
      for (const evidence of data.evidence || []) {
        if (!evidence.pullRequest) continue;
        const link = root.createElement("a");
        link.href = evidence.pullRequest.url;
        link.textContent = `PR #${evidence.pullRequest.number} · ${evidence.remoteSha}`;
        el("github-links").append(link);
      }
    } catch (e) {
      if (current === generation) {
        el("github-controls").hidden = false;
        el("github-status").textContent = "连接信息读取失败：" + String(e);
      }
    }
  }
  async function remoteCommand(
    action: string,
    fields: Record<string, unknown> = {}
  ) {
    const current = generation;
    try {
      await apiRequest(
        `/api/workspaces/${encodeURIComponent(value("contract"))}/github`,
        "POST",
        { action, version, ...fields }
      );
      if (current === generation) el("load").click();
    } catch (e) {
      if (current === generation)
        el("github-status").textContent =
          "操作未完成，可重试恢复：" + String(e);
    }
  }
  el("github-connect").addEventListener("submit", event => {
    event.preventDefault();
    const scopes = ["read"];
    if ((el("github-write") as HTMLInputElement).checked) scopes.push("write");
    if ((el("github-pr") as HTMLInputElement).checked) scopes.push("create_pr");
    const fields = {
      profileId: value("github-profile"),
      scopes,
      ttlMs: 900000
    };
    const key = JSON.stringify({
      contract: value("contract"),
      version,
      ...fields
    });
    if (connectionPlan?.key === key) {
      if (!(el("github-confirm") as HTMLInputElement).checked) return;
      const confirmationId = connectionPlan.confirmationId;
      connectionPlan = undefined;
      void remoteCommand("connect", {
        ...fields,
        confirmationId,
        confirmed: true
      });
      return;
    }
    const current = generation;
    connectionPlan = undefined;
    (el("github-confirm") as HTMLInputElement).checked = false;
    void apiRequest(
      `/api/workspaces/${encodeURIComponent(value("contract"))}/github`,
      "POST",
      { action: "prepare_connect", version, ...fields }
    )
      .then(plan => {
        if (current !== generation) return;
        connectionPlan = { key, confirmationId: plan.confirmationId };
        (el("github-confirm") as HTMLInputElement).checked = false;
        el("github-status").textContent =
          "请核对计划后重新勾选并确认：" + JSON.stringify(plan);
      })
      .catch(e => {
        if (current === generation) el("github-status").textContent = String(e);
      });
  });
  el("github-revoke").addEventListener(
    "click",
    () => void remoteCommand("revoke", { confirmed: true })
  );
  for (const [id, action] of [
    ["github-sync", "sync"],
    ["github-create-pr", "create_pr"],
    ["github-checks", "checks"]
  ])
    el(id!).addEventListener(
      "click",
      () => void remoteCommand(action!, { sha: value("github-sha") })
    );
  let sourceGeneration = 0;
  async function refreshSources() {
    const source = ++sourceGeneration;
    const current = generation;
    try {
      el("zip-file").replaceChildren();
      const contract = encodeURIComponent(value("contract"));
      const [files, delivery] = await Promise.all([
        apiRequest(`/api/files?kind=artifact&resourceId=${contract}`),
        apiRequest(`/api/contracts/${contract}`)
      ]);
      const usedFiles = new Set(
        delivery.zipDeliveries.map((d: { file_id: string }) => d.file_id)
      );
      if (current !== generation) return;
      if (source !== sourceGeneration) return;
      el("source-file").replaceChildren();
      el("zip-file").replaceChildren();
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
        if (
          file.mime === "application/zip" &&
          file.milestone_id === value("file-milestone") &&
          !usedFiles.has(file.id)
        ) {
          const zip = root.createElement("option");
          zip.value = file.id;
          zip.textContent = `${file.name} · ${
            file.size
          } 字节 · 扫描时间 ${new Date(file.scanned_at).toISOString()} · 文件 ${
            file.id
          } · SHA-256 ${file.checksum}`;
          el("zip-file").append(zip);
        }
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
  el("zip-refresh").addEventListener("click", () => void refreshSources());
  el("file-milestone").addEventListener("input", () => {
    void refreshSources();
    void review.refresh().catch(e => {
      el("status").textContent = String(e);
    });
    el("file-refresh")?.click();
  });
  el("zip-form").addEventListener("submit", event => {
    event.preventDefault();
    void gitCommand("submit_milestone", {
      milestoneId: value("file-milestone"),
      fileId: value("zip-file"),
      summary: value("zip-summary"),
      instructions: value("zip-instructions"),
      knownIssues: value("zip-issues")
    });
  });
  el("git-extension").addEventListener("toggle", () => {
    if ((el("git-extension") as HTMLDetailsElement).open) el("load").click();
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
