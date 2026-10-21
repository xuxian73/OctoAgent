# 私有文件存储与传输

真实字节保存在 SQLite `private_files.bytes`，与服务器生成的 UUID、实际字节数、SHA-256、上传身份/责任人、版本归属一起持久化。数据库位于 `DATABASE_URL` 指定的私有位置，不能放入 Web 静态目录或由反向代理公开。备份、操作系统访问权限沿用数据库运维边界。文件名从不作为文件系统路径使用；不接受服务器文件路径、存储键或符号链接作为上传源。

## 接口

所有接口使用既有 Web 会话/CSRF 或授权 Token；每次请求重新检查当前资源权限，不提供公开直链。

- `POST /api/files`：`application/octet-stream` 原始字节，`X-File-Metadata` 为 URI 编码 JSON。字段为 `kind`（`requirement` / `artifact`）、`resourceId`、`version`、`revision`、`milestoneId`、可选 `sha`（默认空）、`name`、`mime`、`requestKey`；可选 `checksum` 仅用作期望值，错误则拒绝。服务端计算大小和摘要。
- 需求文件绑定当前已发布版本和草稿 revision；`milestoneId`、`sha` 必须为空。ZIP 制品绑定合同版本和该版本里程碑，不要求 Git SHA；仅可选 Git 导入兼容旧 SHA 关联，上传需要现有 artifact 授权。
- `GET /api/files?kind=...&resourceId=...`：授权文件列表，包含版本、责任人、摘要和扫描状态。
- `GET /api/files/:id`：元数据。
- `GET /api/files/:id/download`：仅 clean 文件返回原始字节；安全文件名、attachment、nosniff、private/no-store。其他状态返回 `FILE_SCAN_BLOCKED`。
- 工作区 `upload_artifact` 命令支持 `fileId`、`sha`、`milestoneId`，重新核对归属、版本和扫描状态；提交再次核验。历史模拟 GitHub 制品继续标识模拟、无实际字节，不是私有文件的下载替代品。

默认每资源版本最多 20 个文件，每个最多 10 MiB。白名单为 UTF-8 `.ts`/`.txt`（text/plain）、`.md`（text/markdown）、合法 `.json`（application/json）、ZIP（application/zip，完整目录、CRC 与内容校验，详见 [ZIP 交付](zip-delivery.md)）。文本类型不代表内容安全；仍必须扫描。ZIP 只持久化原包；扫描器受限读取内容，不写入应用目录、不执行。`FILE_MAX_BYTES`、`FILE_MAX_COUNT`、`FILE_EXTENSIONS` 环境变量配置数量、大小及扩展名白名单（扩展名必须是上述白名单的子集，大小不能超过 10 MiB）。

## 扫描边界

新文件一律 quarantined。服务端异步 ByteScanner 扫描持久化字节及服务器摘要，进入 scanning 后写入 clean/rejected/unavailable；HTTP 不允许指定状态。ClamAV 子进程全进程并发上限为 2，超额请求失败关闭，可授权重试；健康接口读取每 60 秒后台更新的缓存。只有当前 checksum 对应的非模拟 clean 允许下载、Git 导入和交付。扫描状态和不可变 file_scan_events 审计记录原子提交，重试保留历史尝试及操作者，旧尝试回写记录为 discarded。

## 事务、重试与恢复

请求先在有限内存中收齐完整字节，再使用 `BEGIN IMMEDIATE` 写入一个不可变 BLOB 行，字节、登记和上传审计一起提交。不存在先写磁盘再登记数据库的双写窗口：中途断流尚未登记，SQL/审计失败或进程退出由 SQLite 回滚；提交后响应丢失可以同键重试。扫描状态允许后续更新，归属及字节由数据库触发器禁止覆盖。

幂等键按上传身份隔离，指纹包含资源、版本、里程碑、SHA、文件名、类型和实际摘要；同键同内容返回已有对象，同键不同内容返回 409。重试也检查当前权限及版本。写锁内检查数量限制，跨进程通过 SQLite 写锁和唯一约束串行提交；锁等待超时失败可重试。相同文件名的新请求生成新 UUID，不覆盖。测试通过注入登记失败、并行 HTTP 请求流和关闭重开数据库验证恢复行为。

旧 `requirement_attachments` 仍是兼容元数据，返回 `hasBytes=0`、`legacy_metadata_only`，页面明确不可下载。没有把历史元数据伪装成实际字节。
