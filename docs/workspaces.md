# 离线交付工作区

合同首次进入 active 时自动建立唯一工作区，保留选定报价的任务版本。每次读取和写入都重新验证合同授权、责任主体和 Agent scope；非 active 合同不能写入。新合同版本不会复用旧提交作为里程碑证据。

甲方从 `/contracts` 进入 `/workspaces`，读取变更、检查日志、PR、制品 SHA-256、里程碑快照、预览地址、未解决风险和审计引用。凭据仅在页面内存中使用，切换身份或合同会清空显示。

## HTTP API

- `GET /api/workspaces/{contractId}`：读取合同工作区。
- `POST /api/workspaces/{contractId}/commands`：执行以下动作；JSON 必须包含 `action`、当前合同 `version`、唯一 `requestKey`，使用 Authorization Bearer 请求头。

| action                                         | 额外字段                                                  | 独立权限       |
| ---------------------------------------------- | --------------------------------------------------------- | -------------- |
| create_workspace_branch                        | branch                                                    | branch         |
| commit                                         | branch、files（相对路径到文本的映射）、summary            | commit         |
| run_check                                      | sha、kind（test/typecheck）                               | check          |
| create_pull_request                            | sha                                                       | pull_request   |
| upload_artifact                                | sha、name、content、checksum（原始 UTF-8 内容的 SHA-256） | artifact       |
| discuss / report_blocker                       | text                                                      | discussion     |
| submit_milestone                               | sha、milestoneId、summary、可选 previewUrl                | submit         |
| authorize                                      | actorId、permission、ttlMs、confirmed=true                | 仅甲方本人     |
| deploy / migrate / delete / expand_permissions | object、impactScope                                       | 仅返回确认请求 |

卖方默认只有读取能力。甲方人工授权按具体卖方或 Agent 身份生效，每项权限最长 15 分钟；ttlMs=0 撤销该项权限。Agent 还必须拥有当前合同的 read/write scope。重试也重新检查授权；相同请求键及内容不重复执行，更换内容返回冲突。

提交里程碑要求当前版本的分支最新提交、test 和 typecheck 均通过、PR 与 checksum 已验证的制品元数据。证据保存在不可修改的合同事件及工作区快照中，里程碑变成 submitted；不代表验收或结算。

## Provider 边界

`GitHubProvider` 当前只有离线 `FakeGitHubProvider`：虚拟 Git 分支、内容寻址提交和 PR，不访问网络、不接收 GitHub 凭据、不执行 shell。检查是确定性的模拟：提交文本包含 `FAKE_FAIL_test` 或 `FAKE_FAIL_typecheck` 时对应检查失败，日志明确标注模拟。制品仅保存元数据，不保存上传内容；输入有路径、长度、敏感内容校验，HTTP 请求限制 600000 字节。

真实仓库执行器、二进制制品存储与扫描不属于该 fake provider。预览地址为卖方提供，平台不访问或证明其可用性。确认请求固定包含影响对象、范围、过期时间和 executed=false；即使传入 confirmed=true 也不执行生产变更，未提供合并或生产执行入口。

## 跨组织订单与接单授权

报价比较中的“选择此报价”要求甲方勾选确认，生成草案后跳转合同。双方可从“我的报价/订单”打开自己的报价、合同和当前版本里程碑；合同 active 后可直接进入同一工作区。合同 API 每次按责任主体和当前 grant 校验，乙方无需加入甲方组织。项目导航仅用于已有项目上下文。

迁移 `0017_contract_parties.sql` 从现有合同双方生成参与关系视图，不删除历史合同、确认或有效权限。新选标只建立合同 read/write，不建立 delegate 或仓库操作权限。历史 delegate 继续有效；显式设置委托有效期或撤销后，以新记录为准。

工作区由甲方逐项确认分支、提交、检查、PR、制品、里程碑、讨论及责任主体的 Agent 委托权限，每次最多 900 秒，0 秒撤销。乙方本人权限、Agent 的各项操作权限、责任主体可委托权限及 Agent 凭据 scope 分别检查；已有凭据也会重新检查委托有效期。授权和撤销沿用不可变审计；过期或已被撤销的授权请求重放被拒绝。非 active 合同及旧合同版本不能执行工作区命令。页面继续明确标注离线模拟 GitHub，不代表真实 Git、检查或支付。
