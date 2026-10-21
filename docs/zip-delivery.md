# ZIP 交付与人工验收（#44）

当前 MVP 每次交付一个 ZIP，加交付说明、运行方法及已知问题。乙方自行开发、测试；平台只保存、扫描和授权下载文件，由甲方明确验收。文件 SHA-256 是字节校验和，不是 Git commit SHA。已有 #41 功能保留在可选 Git 扩展中；#42/#43 的隔离代码检查及 GitHub 交付要求延期，不作为本流程前置。

## 操作与接口

1. 双方确认同一合同版本，合同进入 active。甲方在工作区分别给乙方本人或 Agent 授予 `artifact` 和 `submit`，最长 15 分钟；Agent 还需当前合同 read/write scope 与责任主体的独立委托授权。
2. 在工作区选里程碑，上传 ZIP，等待扫描。`POST /api/files` 发送原始字节与 `X-File-Metadata`，字段参见 [文件接口](private-files.md)；ZIP 的 `sha` 可省略。上传返回不可变文件 ID、服务器计算的 size、checksum 和扫描状态。
3. `POST /api/workspaces/:contract/commands` 提交以下 JSON；页面使用相同接口：

```json
{
  "action": "submit_milestone",
  "version": 1,
  "requestKey": "unique-delivery-request",
  "milestoneId": "当前里程碑 ID",
  "fileId": "扫描放行的 ZIP 文件 ID",
  "summary": "交付内容",
  "instructions": "运行方法",
  "knownIssues": "已知问题；无则写无"
}
```

合同命令的 `milestone → submitted` 兼容入口也要求上述 ZIP 字段，并沿用人工确认、原因、version/revision 与 submit 授权，文字 evidence 不再满足交付。

4. 甲方在文件列表通过 `GET /api/files/:id/download` 下载原包。在合同页面填写原因、勾选人工确认，再要求修改或验收。对应 `POST /api/contracts/:id/commands` 的 milestone 命令携带当前 `version`、`revision`、`milestoneId`、`deliveryId`、`to`（changes_requested / accepted）、`requestKey`、`confirmed: true`、`reason: {code, detail}`。Agent 只能生成甲方确认交接，不能代替确认。
5. 返工重新上传文件（同名也生成新 UUID），重交生成递增 `delivery_version`。每个文件只绑定一次正式交付。旧版本、旧确认、旧幂等键不会推进新提交。所有当前版本里程碑验收后，甲方才可把合同改为 completed；不自动结算。

`zip_deliveries` 保存不可变的文件、合同版本、里程碑、责任主体、交付版本、说明及摘要。文件、扫描尝试和合同/工作区事件保留。旧模拟记录原样展示，不为历史 completed 生成 ZIP。数据库新增迁移只增加表，不覆盖用户数据库。

## MCP

- `upload_file`：workspace_id、version、milestone_id、name、content_base64、request_id。只上传 ZIP；服务端开始扫描，使用 `get_file` 轮询状态。
- `get_file` / `download_file`：contract_id、file_id、request_id；下载返回原字节的 base64。每次调用及重放重新鉴权、核验当前扫描状态。
- `submit_milestone`：workspace_id、version、milestone_id、file_id、summary、instructions、known_issues、request_id。与 Web 共用业务服务，不要求 SHA、检查日志或 PR。
- `request_changes` / `accept_milestone` 带 delivery_id，返回人工确认交接；实际操作仍由甲方业务 API 再次核对当前 revision 与 deliveryId。

## ZIP 与扫描限制

只支持单卷经典 ZIP 的 stored/deflate 条目（包含合法 data descriptor），不支持 ZIP64、加密或无法检查的压缩方法。检查中央目录、局部头、长度、名称、实际解压长度和 CRC；拒绝损坏、重复名称、路径穿越、绝对路径、反斜线、盘符、符号链接和其他特殊文件。不将任何条目写入应用目录，也不执行内容。

压缩输入最多 10 MiB，单条目最多 10 MiB，累计展开内容（包含嵌套）最多 20 MiB、最多 1000 条目，超过 1 KiB 的条目压缩比不超过 100，嵌套归档最多 3 层。结构校验总预算 2 秒，每次 inflate 有输出上限。ClamAV 另限制扫描体积 30 MiB、文件 10 MiB、1000 条目、递归 4 层及扫描 30 秒；外层子进程超时按部署配置强制终止，并发最多 2。超限、加密、感染拒绝；程序、病毒库缺失、超时或异常不可放行。页面显示扫描状态；ZIP 结构错误以 ZIP\_\* 原因返回。

离线检查 `./scripts/check.sh` 使用明确命名的受控扫描适配器与进程 fixture，验证的是门槛和流程，不证明病毒扫描有效。真实联调运行：

```sh
npm run scan:integration
```

需部署者已安装可信 ClamAV 与病毒库。正常文本/ZIP 应 clean，标准 EICAR 文本/ZIP 应 rejected；任何一项不符或缺依赖均报告未验证并退出 1。平台不会为运行此命令下载或安装依赖。
