# OctoAgent 项目约定

需求以 `docs/spec.md` 为准。每个 issue 只实现其要求的内容；范围外的问题记录为后续 issue。

## 提交前检查

运行 `./scripts/check.sh`。测试必须离线可重复，不得把密钥、令牌或个人信息写入代码、日志和测试数据。

## GitHub 与 agent 边界

- 不要在 agent 中执行 `git push` 或直接调用 `gh` 改动远程仓库。
- 修改前先阅读相关代码和现有测试。
- 提交信息使用 `<type>: <摘要> (#<issue 号>)`，type 使用 `feat`、`fix`、`test`、`docs`、`chore`、`refactor`。
