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

历史实现（以下仅描述显式模拟测试）：`GitHubProvider` 的离线 `FakeGitHubProvider`：虚拟 Git 分支、内容寻址提交和 PR，不访问网络、不接收 GitHub 凭据、不执行 shell。检查是确定性的模拟：提交文本包含 `FAKE_FAIL_test` 或 `FAKE_FAIL_typecheck` 时对应检查失败，日志明确标注模拟。制品仅保存元数据，不保存上传内容；输入有路径、长度、敏感内容校验，HTTP 请求限制 600000 字节。

真实仓库执行器、二进制制品存储与扫描不属于该 fake provider。预览地址为卖方提供，平台不访问或证明其可用性。确认请求固定包含影响对象、范围、过期时间和 executed=false；即使传入 confirmed=true 也不执行生产变更，未提供合并或生产执行入口。

## 跨组织订单与接单授权

报价比较中的“选择此报价”要求甲方勾选确认，生成草案后跳转合同。双方可从“我的报价/订单”打开自己的报价、合同和当前版本里程碑；合同 active 后可直接进入同一工作区。合同 API 每次按责任主体和当前 grant 校验，乙方无需加入甲方组织。项目导航仅用于已有项目上下文。

迁移 `0017_contract_parties.sql` 从现有合同双方生成参与关系视图，不删除历史合同、确认或有效权限。新选标只建立合同 read/write，不建立 delegate 或仓库操作权限。历史 delegate 继续有效；显式设置委托有效期或撤销后，以新记录为准。

工作区由甲方逐项确认分支、提交、检查、PR、制品、里程碑、讨论及责任主体的 Agent 委托权限，每次最多 900 秒，0 秒撤销。乙方本人权限、Agent 的各项操作权限、责任主体可委托权限及 Agent 凭据 scope 分别检查；已有凭据也会重新检查委托有效期。授权和撤销沿用不可变审计；过期或已被撤销的授权请求重放被拒绝。非 active 合同及旧合同版本不能执行工作区命令。页面继续明确标注离线模拟 GitHub，不代表真实 Git、检查或支付。

## 真实本地 Git（#41）

应用默认使用真实本地 Git；旧 JSON 模拟记录显示 `legacy-simulation`，不迁移成真实提交。只有测试/离线演示显式注入 `FakeGitHubProvider` 时才使用 `offline-fake`。真实模式不创建 PR、不运行检查或代码，相关操作明确返回 `LOCAL_GIT_OPERATION_UNAVAILABLE`。

部署须安装 `/usr/bin/git`，设置 `WORKSPACE_GIT_ROOT` 为应用专用的绝对、无符号链接目录（macOS 请用 `/private/...` 等规范路径）。Compose 已使用私有数据卷中的 `/app/.data/repositories`。目录应仅由应用 OS 用户写入，不挂载宿主凭据；不能与其他应用实例的独立数据库共用。未配置根目录、Git 缺失、仓库缺失/损坏均报错，不回退模拟。该配置不是网页输入，也不接受远端地址或 Git 命令。

甲方明确授权乙方 `branch`、`commit`、`artifact` 后，乙方在 active 合同的工作区初始化仓库、创建分支，选择里程碑上传代码文件（提交选择“待导入代码”）。真实扫描放行后重新读取，选择制品、仓库内相对路径和提交说明即可导入。ZIP 不作为单个代码文件导入；不解包。原始字节不转码，提交记录保存来源制品 ID、SHA-256、目标路径、合同版本、完整 Git SHA 和真实 diff。页面不会要求输入 UUID 或提交 SHA。

每合同目录使用合同 ID 的 SHA-256；每次写入创建独立的完整仓库快照，保留真实工作树和 `.git`。现有 SQLite `BEGIN IMMEDIATE` 写锁覆盖权限复核、Git 操作、状态指针、请求去重结果和审计提交，因此同数据库多个进程串行化；忙锁/超时返回失败，可原请求重试。快照生成号绑定前代和已授权请求指纹；已发布快照不修改。数据库回滚或进程中断留下的未发布快照不显示为成功，下次相同请求会重建它；数据库提交后的重复请求返回已记录结果且重新核验真实仓库。无需跨文件系统事务。重启读取以数据库指针定位真实仓库，执行对象完整性和引用核验；丢失目录不得自动重建成成功。

快照策略以存储空间换取简单恢复，暂不自动回收历史/孤立快照；运维如需清理，须停服并备份数据库和整个目录，保留当前所有状态指针指向的快照。文件系统与数据库必须一起备份/恢复。进程中断可恢复；硬件/卷丢失按损坏报错，不保证跨卷断电原子性。

Git 以固定可执行文件及参数数组调用，环境仅保留固定白名单，禁用系统/用户配置、凭据 helper、交互认证、协议、模板、hooks、外部 diff/textconv。仓库配置必须与平台生成的固定内容一致，拒绝 config include、对象 alternates、grafts、符号链接和路径逃逸；用户上传不能写隐藏 Git 配置文件。仓库根目录必须是受信任的部署边界，不能给其他 OS 用户并发写权限。
