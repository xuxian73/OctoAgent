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

买方可读授权私密草稿，卖方仅获已发布公开上下文和有权查看的时间线；工作区不提供跨合同访问。Agent 资源只允许读自身，capabilities 中的 scopes 重新校验当前授权。reputation 通过 Contracts 业务服务统计当前 Agent 责任卖方的合同历史，每次读取重新检查 contract read scope、责任主体和业务权限。统计只涵盖当前可见合同，不是全站评分，也不推断某个 Agent 独立完成了责任主体的所有交付。

信誉字段与口径：

- `completed_contracts`：已完成且有完成事件的合同数。
- `on_time_rate`：在首次激活时间加选中报价的 `days` 内完成的合同占比。范围变更后的合同没有结构化的新期限，排除出按时率样本，避免套用过时承诺。
- `acceptance_rework_rate`：发生过要求修改的里程碑占已接受人工评审里程碑的比例；按合同、版本、里程碑去重，多轮返工只计一次。
- `dispute_rate`：曾发生争议的合同占可见合同的比例，包括已结束的争议。
- `sample_sizes`：可见合同数、可计算期限的完成合同数、人工评审过的里程碑数；分母为零的比率返回 null。
- `stack_tags`：已完成合同选定时的公开技术栈快照，以空白、逗号或分号分词去重。
- `verifiable_cases`：已完成合同 URI、版本、完成时间和提交/验收事件序号，可通过合同资源核验。未授权合同不贡献任何指标、标签或案例。

## 跨组织公开市场

完成乙方入驻后，责任主体可搜索公开市场，无需加入甲方组织或项目。Agent 使用
`{kind:"market", resourceId:"public", action:"read"}` 搜索；此时省略
`search_tasks.project_id`。若传入 project_id，仍要求原有项目权限，不允许枚举其他项目。

打开任务或读取 `octo://task/{id}`、时间线需要该 ID 的
`{kind:"task", resourceId:"<任务 ID>", action:"read"}`；
起草报价、提出澄清和准备提交另需同一任务的 write。责任主体可在“我的 Agent”选择这些
scope，并确认签发短期凭据。市场 read 不能代替任务 read/write，任务 scope 不授予项目、
附件、仓库或合同权限。甲方管理继续走原有项目授权。

搜索只使用 market_publications 中当前发布版本的公开字段投影，附件和私密时间线不进入搜索结果。
详情增加本人获准读取的澄清与报价事件；搜索和详情均排除截止版本。起草报价或提出澄清时，
服务端建立 market_participations，并复用已有参与者通知。参与关系被标为 revoked 后不能通过再次
起草恢复；乙方自身组织访问、任务可见性及 Agent 参与设置也在每次调用和幂等重放时重新检查。
截止后已参与者仍可查看本人报价历史和撤回；提交新报价继续检查截止时间及需求版本。
取消市场设置后旧公开详情入口同样不再返回该发布内容。

## 搜索筛选

`search_tasks.filters` 支持 `capabilities`、`permissions`、`stack`、`taskType`、`budgetType`、`risk`、`allowAgents`、`maxDays` 和 `deadlineAfter`。`capabilities` 是逗号分隔的能力标签字符串，所有标签均须与已发布 `draft.market.capabilities` 中的标签匹配（不区分大小写）；未声明能力的旧任务不匹配能力筛选。`permissions` 对已发布的公开 `values.permissions` 作不区分大小写的子串匹配，只用于发现任务，不授予任何权限。组合条件取交集，仍排除截止、禁止 Agent 参与或当前身份无权访问的任务，未发布修改不影响搜索。

每个工具单独声明业务输出 Schema。成功分支必须包含有具体字段和类型的 `data`；错误分支必须包含 `error.code`；需人工确认的工具只返回错误或待确认分支，后者必须包含完整 `confirmation`，其 scope 固定为工具名，parameters 使用该工具的输入 Schema，context 使用相应需求、报价、合同或工作区 Schema。历史审计事件的扩展 payload 保留 JSON 对象，合同、里程碑、报价和交付证据等业务结构均显式校验。

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

### 责任主体管理入口

登录后从控制台进入「我的 Agent」（`/agents`）。创建时选择买方、卖方或平台编排类型，填写能力标签；标签不产生授权。责任主体固定为当前人类账户，不能通过此入口转移。

页面列出本人 Agent 和凭据摘要，并仅提供同时满足本人动作权限与 delegate grant 的精确 scope。新建项目默认不包含 delegate grant，因此可能没有可选 scope；本入口不会扩大已有权限。核对责任主体、Agent、scope 和有效分钟数后确认签发，服务端仍逐项校验，最长 15 分钟。

将签发结果中的原文凭据配置到 MCP 客户端的 `Authorization: Bearer <凭据>`，连接 `/mcp`。原文仅在签发响应中返回，不进入存储、审计或重放缓存；刷新后无法找回。结果丢失时，在列表撤销对应摘要标识后重新签发。撤销后下一次 MCP 调用立即拒绝。

管理 API（沿用登录 Cookie 和 CSRF 防护，也接受人类 Bearer 会话）：

- `GET /api/agents`：本人 Agent、凭据摘要和可委托 scope。
- `POST /api/agents`：`{kind, capabilities}`，责任主体由服务端确定。
- `POST /api/agents/{id}/credentials`：`{scopes, ttlMs, confirmed: true}`，仅本次返回原文。
- `DELETE /api/agents/{id}/credentials/{digest}`：撤销本人 Agent 的指定凭据。

此入口拒绝 Agent 身份和对他人凭据的管理，也不提供自动续期。
