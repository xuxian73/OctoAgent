import { apiRequest } from "./client.js";
import { Agent, Scope } from "../../../packages/auth/src/model.js";

export function renderAgents() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的 Agent · OctoAgent</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><main class="requirement-editor"><h1>我的 Agent</h1><p id="owner"></p><p>能力标签仅描述能力，不产生授权。凭据最长有效 15 分钟，可随时撤销。</p><form id="create-agent"><label>类型<select id="agent-kind"><option value="buyer">买方</option><option value="seller">卖方</option><option value="orchestrator">平台编排</option></select></label><label>能力标签（逗号分隔，最多 20 个）<input id="capabilities" maxlength="1600"></label><button>创建 Agent</button></form><h2>签发 MCP 凭据</h2><form id="issue-agent"><label>Agent<select id="agent-id" required></select></label><fieldset id="scopes"><legend>精确 scope（不选则无业务权限）</legend></fieldset><label>有效分钟数<input id="ttl" type="number" min="1" max="15" value="15" required></label><p>提交后将显示责任主体、scope 和有效期，请核对后确认签发。</p><button>核对并签发</button></form><section aria-label="一次性凭据"><p>原文仅在本次签发结果展示。请配置 MCP 客户端连接 /mcp，使用 Authorization: Bearer 凭据；刷新后无法找回。</p><pre id="issued-token"></pre><button id="hide-token">清除原文</button></section><p id="status" role="status"></p><h2>Agent 与凭据记录</h2><div id="agent-list"></div><a href="/console">返回控制台</a></main><script type="module" src="/agents.js"></script></body></html>`;
}
type ListedAgent = Agent & {
  credentials: {
    id: string;
    scopes: Scope[];
    expiresAt: number;
    revoked: boolean;
  }[];
};
export function mountAgents(
  root: Document,
  confirmIssue = (message: string) => window.confirm(message)
) {
  if (!root.getElementById("create-agent")) return;
  const element = (id: string) => root.getElementById(id)!;
  const value = (id: string) => (element(id) as HTMLInputElement).value;
  let owner = "";
  let scopes: Scope[] = [];
  let busy = false;
  async function refresh() {
    const data = await apiRequest("/api/agents");
    owner = data.responsibleUserId;
    const contract =
      typeof location !== "undefined"
        ? new URLSearchParams(location.search).get("contract")
        : null;
    scopes = contract
      ? data.scopes.filter(
          (scope: Scope) =>
            scope.kind === "contract" && scope.resourceId === contract
        )
      : data.scopes;
    element("owner").textContent = "责任主体：" + owner;
    element("agent-id").replaceChildren();
    element("agent-list").replaceChildren();
    for (const agent of data.agents as ListedAgent[]) {
      const option = root.createElement("option");
      option.value = agent.id;
      option.textContent = agent.kind + " · " + agent.id;
      element("agent-id").append(option);
      const section = root.createElement("section");
      const title = root.createElement("h3");
      title.textContent =
        agent.kind + " · " + agent.id + " · " + agent.capabilities.join(", ");
      section.append(title);
      for (const credential of agent.credentials) {
        const row = root.createElement("p");
        row.textContent =
          credential.id +
          " · " +
          JSON.stringify(credential.scopes) +
          " · 到期 " +
          new Date(credential.expiresAt).toISOString() +
          " · " +
          (credential.revoked
            ? "已撤销"
            : credential.expiresAt <= Date.now()
            ? "已过期"
            : "有效");
        if (!credential.revoked) {
          const button = root.createElement("button");
          button.textContent = "撤销";
          button.addEventListener("click", () =>
            run(async () => {
              element("issued-token").textContent = "";
              await apiRequest(
                "/api/agents/" + agent.id + "/credentials/" + credential.id,
                "DELETE"
              );
              await refresh();
            })
          );
          row.append(button);
        }
        section.append(row);
      }
      element("agent-list").append(section);
    }
    const fieldset = element("scopes");
    fieldset.replaceChildren();
    const legend = root.createElement("legend");
    legend.textContent = "精确 scope（不选则无业务权限）";
    fieldset.append(legend);
    scopes.forEach((scope, index) => {
      const label = root.createElement("label");
      const input = root.createElement("input");
      input.type = "checkbox";
      input.id = "scope-" + index;
      label.append(
        input,
        root.createTextNode(
          scope.kind + " / " + scope.resourceId + " / " + scope.action
        )
      );
      fieldset.append(label);
    });
  }
  function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    element("status").textContent = "";
    void action()
      .catch(() => {
        element("status").textContent =
          "操作未完成，请刷新检查记录后重试；签发结果丢失时可撤销对应凭据。";
      })
      .finally(() => {
        busy = false;
      });
  }
  element("create-agent").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      await apiRequest("/api/agents", "POST", {
        kind: value("agent-kind"),
        capabilities: value("capabilities")
          .split(/[,，]/)
          .map(s => s.trim())
          .filter(Boolean)
      });
      await refresh();
    });
  });
  element("issue-agent").addEventListener("submit", event => {
    event.preventDefault();
    run(async () => {
      element("issued-token").textContent = "";
      const selected = scopes.filter(
        (_, index) => (element("scope-" + index) as HTMLInputElement).checked
      );
      const ttlMs = Number(value("ttl")) * 60000;
      const id = value("agent-id");
      if (
        !confirmIssue(
          "责任主体：" +
            owner +
            "\nAgent：" +
            id +
            "\nscope：" +
            JSON.stringify(selected) +
            "\n有效分钟：" +
            ttlMs / 60000 +
            "\n确认签发？"
        )
      )
        return;
      const result = await apiRequest(
        "/api/agents/" + id + "/credentials",
        "POST",
        { scopes: selected, ttlMs, confirmed: true }
      );
      element("issued-token").textContent = result.token;
      await refresh();
    });
  });
  element("hide-token").addEventListener("click", () => {
    element("issued-token").textContent = "";
  });
  run(refresh);
}
if (typeof document !== "undefined") mountAgents(document);
