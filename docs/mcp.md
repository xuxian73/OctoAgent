# Marketplace MCP

运行迁移和应用后，兼容客户端连接 `/mcp`（MCP Streamable HTTP，JSON 响应、无服务端会话）。使用 `Authorization: Bearer <短期 Agent Token>`，每个 HTTP 请求都携带授权。身份由现有服务端身份系统签发，不从工具参数、Cookie 或提示词推断。此入口拒绝浏览器 Origin；需要浏览器客户端的部署应另行配置可信网关，不开放通配跨域。

依赖锁定在 package.json / package-lock.json。检查与测试离线运行；`tests/mcp.test.ts` 使用官方 SDK 的 Client 与 InMemoryTransport，不连接网络或 GitHub。

## 发现和返回结构

`tools/list` 提供需求第 4 节全部 24 个工具及输入/输出 JSON Schema。参数采用 snake_case；嵌套 draft/proposal 沿用业务服务字段。未知字段（包括 `confirmed`、用户身份和凭据）会被拒绝。所有工具必须提供 `request_id`；它是调用方生成的幂等键，不是授权凭据。

工具同时提供 JSON 文本与 `structuredContent`，包含 `request_id`、`status`、`next_step`、`summary`、`requires_human_confirmation`，以及 `data` 或 `error.code`。业务失败设置 MCP `isError`，越权与不存在统一返回 `FORBIDDEN`。MCP 协议本身的发现、初始化和协议错误仍遵循 SDK 标准结构。

`draft_task` 把 description 放入私密 goal 草稿，或保存客户端整理的结构化 draft，不使用 LLM 猜测缺失字段。`validate_task` 返回缺失项、无效项和风险；`review_milestone` 返回验收规则、证据和未决风险供人工逐项核对，不自动判断验收通过。

## 授权与资源

项目工具要求精确 project read scope，写操作另需 write；合同工具要求精确 contract read/write scope。服务端再次校验组织、项目成员关系、甲乙责任主体、需求允许 Agent 参与的设置、报价归属及合同参与者。工作区沿用合同 ID，并额外检查 branch/check/pull_request/submit/discussion 的短期独立授权。

`resources/templates/list` 提供以下八个 URI 模板，具体 ID 不做全库枚举。`resources/list` 只列出当前 Agent 自身的两个资源：

- `octo://task/{id}`、`octo://task/{id}/timeline`
- `octo://contract/{id}`、`octo://contract/{id}/milestones`
- `octo://workspace/{id}/changes`、`octo://workspace/{id}/checks`
- `octo://agent/{id}/capabilities`、`octo://agent/{id}/reputation`

买方可读授权私密草稿，卖方仅获已发布公开上下文和有权查看的时间线；工作区不提供跨合同访问。Agent 资源只允许读自身，capabilities 中的 scopes 重新校验当前授权。现有业务层尚无信誉统计，reputation 明确返回 `status: not_available, metrics: null`，不编造指标或不可解释评分。

`task_intake`、`bid_proposal`、`delivery_review` 提示词都支持可选 context，明确将其标记为不可信数据；上下文不能授予权限，也不能替代人工确认。

## 人工确认协议

发布、提交或撤回报价、选定报价、要求修改、验收、争议、创建分支、运行检查、创建 PR 和提交里程碑，均只准备人工确认，不执行这些业务动作。返回：

- `requires_human_confirmation: true`
- `confirmation.scope`：精确工具名
- `confirmation.affected_objects`：任务、报价、合同、工作区及里程碑 ID
- `confirmation.parameters` 和 `context`：拟执行参数与当前授权业务快照
- `confirmation.expires_at`：五分钟有效期的 Unix 毫秒时间戳

该响应不是可兑付的执行凭据。Agent 无法通过传入 `confirmed: true` 或重放确认请求执行动作。人工须检查范围、预算、交付物及验收标准，然后通过已有业务 API 重新获取当前版本并确认：

| 动作             | 人工业务入口                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| 发布需求         | `/api/requirements/{id}/preview` 后 `/publish`，使用该人工会话取得的 confirmation    |
| 提交报价         | `/api/market/bids/{id}/preview` 后 `/submit`，使用人工 confirmation                  |
| 撤回报价         | `/api/market/bids/{id}/withdraw`                                                     |
| 选定报价         | `/api/contracts/select`                                                              |
| 修改、验收、争议 | `/api/contracts/{id}/commands`，最新 version/revision、结构化 reason、人工 confirmed |
| 工作区操作       | `/api/workspaces/{id}/commands`，最新 version 和独立授权；执行者必须具备相应权限     |

合同命令将 milestone_id 转成 milestoneId，修改和验收分别使用 action=milestone、to=changes_requested/accepted，争议使用 action=transition、to=disputed。工作区同样使用现有命令字段 milestoneId/previewUrl/requestKey，不能将 Agent 授权当成人类账户授权。

重复相同请求返回原结果；过期确认返回 `CONFIRMATION_EXPIRED`，业务快照改变返回 `STALE_CONFIRMATION`，须以新 request_id 重新准备。人工 API 保留自己的身份、版本、状态机和确认校验，MCP 不绕过这些规则。

## 幂等与存储

迁移 `0007_mcp.sql` 添加不可覆盖的请求记录。键绑定 Agent ID、责任主体 ID 和 request_id；规范化参数指纹拒绝同键改参，结果与业务变更在同一数据库事务中提交。Market 和 Workspaces 使用可嵌套 savepoint，使记录失败时业务操作也回滚。重启不会丢失去重结果；每次重放仍先重新校验当前凭据、scope 和业务对象授权。需要最新读取结果时使用新 request_id。

MCP 适配器只调用业务服务，不查询数据库，不接收人类凭据，不执行支付或生产操作。读取失败不返回对象 ID、内部异常或私密数据。
