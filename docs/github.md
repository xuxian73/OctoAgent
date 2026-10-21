# 显式 GitHub 连接（#43）

状态：已实现 REST 适配和离线 HTTP 协议验证；**实际 GitHub 联调未验证**。没有执行 git push、gh、合并、部署或生产仓库测试。离线测试不能证明真实账号权限、GitHub 策略或网络环境已可用。

## 部署与责任主体确认

无需配置 GitHub 即可使用真实本地 Git。继续按 [本地 Git 部署说明](local-git.md) 配置独立仓库目录。新增 SQLite schema 通过既有迁移入口应用；这不代表已执行生产迁移。

部署者提供服务账户可读、权限 `0600`、非符号链接的 JSON 文件，使用 `OCTO_GITHUB_CONFIG` 指定路径。文件不放在仓库、Web 静态目录或浏览器中。内容是配置数组，例如：

```json
[
  {
    "id": "delivery-test",
    "contractId": "目标合同 ID",
    "responsibleUserId": "合同甲方用户 ID",
    "repositoryId": 123456,
    "owner": "test-owner",
    "repo": "test-repository",
    "base": "main",
    "credentialEnv": "OCTO_GITHUB_CREDENTIAL_DELIVERY",
    "allowed": ["read"],
    "expiresAt": 0
  }
]
```

将身份替换为明确授权的测试仓库及真实合同；`expiresAt` 设置为短期未来 Unix 毫秒时间（示例 0 故意不可用）。当前仓库名、owner、base 仅支持字母、数字、下划线和连字符；基线必须已有提交。GitHub.com API origin 固定，浏览器不能指定 API 地址。适配器的 loopback origin/transport 注入仅供离线测试。

通过部署系统的秘密注入机制设置 `OCTO_GITHUB_CREDENTIAL_DELIVERY`，值为短期、限该仓库的 GitHub App installation token 或 fine-grained token。不要将值写入配置 JSON、`.env.example`、命令历史、日志、fixtures 或版本库。应用不读取宿主 `gh`、`GH_TOKEN`、Git credential helper，也不存储令牌到业务数据库。轮换令牌可以沿用引用；移除引用、移除配置或缩短配置有效期立即拒绝后续调用。部署者负责在 GitHub 侧撤销或轮换凭据。

默认配置 `allowed: ["read"]`。需要写入时由部署者独立增加 `write`，创建 PR 独立增加 `create_pr`；服务端绝不接受 `merge` 或 `deploy`。GitHub 底层至少需要 Metadata read、Contents read、Checks read；同步需 Contents write，PR 创建需 Pull requests write（读取 PR 需要对应 read）。平台再施加独立权限上限，即使底层 token 更宽也不暴露合并、部署、任意 HTTP 请求或任意 ref 更新能力。

甲方登录交付工作区，选择部署者预配置仓库，核对数字仓库 ID、base、上限和到期时间；默认不勾选写入和创建 PR，先生成服务端确认计划，核对计划中的仓库、合同版本、scope 和绝对到期时间，再重新勾选责任主体确认并连接。页面不收取密钥。连接绑定合同版本、甲方、配置摘要、凭据引用（仅服务端配置）、scope 和有效期，最长 15 分钟且不超过配置期限。配置改变、合同版本改变、到期或撤销会失效。续期/扩大范围需重新生成计划并明确确认。计划 ID 由服务端生成并持久化，一次性使用；有效期从生成计划时起算，重复提交不延长。连接成功、降权或撤销会原子作废同合同所有待确认计划；旧请求和其他页面延迟请求均不能恢复权限。配置、合同版本、主体、scope 或期限不符也拒绝。只有合同甲方本人能连接或撤销，Agent 不可替代。

乙方同步还需甲方对该乙方/Agent 分别授予 `branch`、`commit` 工作区权限；创建 PR 需 `pull_request`，与连接的 `create_pr` 同时满足。只读远端检查不需要本地检查执行器或本地 `check` 权限。所有操作重新校验会话、合同访问、状态、scope 和有效期；每个网络请求前后都检查，撤销时已发出的远端请求可能完成，但不会继续写证据或发送后续变更请求。

## 同步与证据

选取当前合同版本、分支当前头部的真实本地提交。服务端核验 Git 对象和源文件 checksum，读取完整文件树，经 GitHub Git Database REST API 上传 base64 blob、tree、commit，再创建独立 `octo-<合同摘要>-<完整本地SHA>` 分支。只允许普通文件，最多 200 个、总计 10 MiB。不执行 push，也不执行仓库代码。

**这是完整快照同步**：远端提交以已记录的 GitHub base SHA 为父提交，但文件树与本地 SHA 的树完全相同。写入前读取固定 base SHA 的完整递归树，校验提交/树身份且拒绝截断结果；若任何基线文件或子模块路径不在本地快照中，返回 `GITHUB_DELETION_DISABLED` 和具体路径，且不发送远端写入。本轮不开放删除能力，通用 write/branch/commit 权限和 confirmed 布尔值均不能绕过。同步重试与 PR 创建都重新检查；base 分支偏离计划 SHA 时拒绝，需人工处理新的基线。本地快照必须保留所有远端基线文件。不会更新 base、强推或覆盖已有不同 SHA 的分支。同步可能触发测试仓库已有的 GitHub Actions；独立实测前必须核对该仓库工作流与秘密配置。

远端 SHA 根据明确提交内容、固定非个人作者和时间计算；blob/tree/commit 响应与本地计算值比较，随后回读 ref 和 commit。仓库数字 ID、全名和 URL 必须匹配；PR 回读并核对编号、head/base 仓库、分支、head SHA 和官方链接。检查按确切远端 SHA 分页读取，任何条目 SHA 不匹配、分页不完整或远端错误均拒绝发布新证据。外部日志、输出、作者信息和任意链接不写入证据。

证据记录 `localSha`、`remoteSha`、`tree`、`baseSha`、合同版本、仓库身份、读取时间和真实 PR 链接。远端检查独立存储，不写入本地 `checks`，不自动满足隔离检查/扫描验收门槛。空检查列表不是通过。本地旧 SHA 的证据仍是历史记录；不得作为新 SHA 的证据。UI 明确显示连接是否有效和检查读取时间，不表示持续实时验证。

连接 API：`GET /api/workspaces/:contract/github`；POST 同一路径，body 为 `action`、`version` 与操作字段。`prepare_connect` 使用 `profileId`、可省略的 `scopes`（默认 read）、`ttlMs`，返回待人工审阅的计划和 `confirmationId`；`connect` 必须携带相同字段、该 `confirmationId` 与 `confirmed: true`；`revoke` 使用 `confirmed: true`；`sync`、`create_pr`、`checks` 使用服务端已核验的本地 `sha`。继承 Web Cookie、CSRF 和合同鉴权。现有 MCP 同步工作区命令仍用于本地操作，远端操作使用此显式 Web/API 入口。

## 重试与失败恢复

在任何远端写入前持久化不可变同步计划；每个连接使用 SQLite 条件更新领取 30 秒租约，每次请求重新校验并续期。并发请求返回 `GITHUB_BUSY`。进程退出后租约过期可重试，同一个本地 SHA 使用原 base 和预期远端 SHA，不跟随新 base 重建计划。HTTP 请求超时 10 秒，禁止重定向，限制响应大小。

blob/tree/commit 是内容寻址对象；孤立对象无可见交付效果。分支已存在时只能接受准确预期 SHA。PR 创建前按 head/base 查询所有状态（含已关闭），请求响应丢失或创建冲突后重新查询并回读验证，绝不自动重开/重复创建已关闭 PR。数据库证据保存失败后同样可重新读取既有远端资源恢复。远端失败不会伪造成功证据；以前保存的证据保留原 SHA 与读取时间。复用同配置、同合同版本的连接保留计划；配置身份改变后不隐式复用旧证据，冲突分支需要人工检查。

## 离线验收

运行 `./scripts/check.sh`，无需账号、凭据或网络。`tests/github.test.ts` 用临时真实 Git 仓库及本地 HTTP stub，通过 Node HTTP 客户端/服务端序列化和解析请求响应。当前沙箱禁止 TCP/Unix socket bind，测试使用内存双工字节流承载 HTTP，未跳过协议断言，未使用 FakeGitHubProvider。认证测试值运行时随机生成，不输出、不持久化。

覆盖连接计划重放（重复、撤销、降权、延迟到达）、范围/配置绑定、删除拒绝与基线变化、递归树完整性，以及请求路径、认证头、blob/tree/commit/ref、PR 查询/创建/回读、checks、scope 分离、未授权主体、撤销/过期、仓库/ref/PR/check 身份不匹配、错误与重定向、并发、响应丢失、数据库部分失败与租约恢复。既有本地 Git、迁移、Web 与其他回归也执行。DOM/API 测试不等于真实浏览器人工验收。

## 独立真实 GitHub 验收（尚未执行）

1. 用户明确授权一个**专用测试仓库**、owner/repo 数字身份、测试合同、写入范围、PR 创建范围和短期有效期；无授权不得测试。确认该仓库没有生产部署工作流或生产秘密。
2. 部署者按上述配置注入限仓库凭据，记录配置引用（不记录值）；甲方在真实浏览器核对并确认只读连接，验证写入/PR 被拒绝。
3. 在明确授权范围内分别启用 write 和 create_pr 并重新确认；乙方导入已放行源制品，创建本地 Git 提交，点击同步和创建 PR。手工在 GitHub 核对仓库 ID、branch、tree、local/remote SHA 对应关系和 PR head/base；保存真实页面链接与脱敏截图。
4. 让测试仓库自己的安全 CI 生成远端检查，点击读取，核对确切 remote SHA 和检查 ID；不得将旧 SHA、空检查或远端检查充当本地隔离检查。
5. 重复点击及模拟客户端响应丢失，确认只有一个 PR；撤销/等待过期后再次操作必须拒绝。检查浏览器存储、响应、审计和部署日志中无凭据。
6. 记录日期、操作者、授权范围、真实资源链接、检查结果和失败项。清理测试分支/PR、撤销测试凭据由已获授权的人独立执行；此应用不合并或部署。未完成以上步骤时始终保留“实际 GitHub 联调未验证”。

协议依据：[Git trees](https://docs.github.com/en/rest/git/trees)、[Git commits](https://docs.github.com/en/rest/git/commits)、[Pull requests](https://docs.github.com/en/rest/pulls/pulls)、[Check runs](https://docs.github.com/en/rest/checks/runs)。
