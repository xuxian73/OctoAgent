# Issue #43 检查报告

实现了显式 GitHub 连接配置和甲方确认/撤销入口、独立 read/write/create_pr 权限、GitHub REST blob/tree/commit/ref 同步、PR 创建/恢复、远端检查读取和本地/远端 SHA 映射。merge/deploy 无执行入口。无需 GitHub 的真实本地 Git 继续可用；远端检查单独存储，不转成隔离检查通过证据。

最终运行 `./scripts/check.sh` 成功：格式、TypeScript、构建、数据库检查 4/4、完整测试 162/162，零失败、零跳过。`git diff --check` 通过。没有提交、push、gh 或生产联调。

新增 `tests/github.test.ts` 六项集成测试覆盖真实 Git 对象、HTTP 协议、权限和身份错误、响应丢失、并发/租约恢复、数据库部分失败、浏览器事件入口及部署配置权限。测试认证值运行时随机生成，不记录真实秘密。本沙箱 TCP 和 Unix socket 监听均返回 EPERM，因此本地 HTTP stub 使用内存双工字节流，由 Node HTTP 客户端与服务端执行真实 HTTP 序列化/解析；不是 FakeGitHubProvider，也不是实际 GitHub 联调。

开发中修复了旧迁移 fixture 未移除新增迁移、两个旧 DOM fixture 缺少新控件导致的失败。既有大文件 Git 测试出现过一次 GIT_OPERATION_FAILED；不改动该测试或 Git 超时，单独重跑及最终完整检查均通过。

Reviewer 请重点检查：

- 服务端私密配置绑定合同、甲方、仓库数字身份、凭据引用、scope 上限及有效期；浏览器不接收凭据。
- 完整快照同步可能在 PR 中删除远端基线里本地不存在的文件；只创建独立分支，不更新基线。
- 不可变计划与预期 Git 对象 hash、分支/PR 回读、SQLite 租约及失败恢复；证据与不可变合同事件、审计在同一事务发布。
- 远端证据显式区分 localSha/remoteSha 与读取时间；空检查、错误身份、过期或撤销连接不能形成新成功证据。

**实际 GitHub 联调和真实浏览器人工验收未验证**。需用户明确授权专用测试仓库后，独立按 [GitHub 验收步骤](github.md) 执行；不能把本报告的离线结果解释为真实 GitHub 已验收。
