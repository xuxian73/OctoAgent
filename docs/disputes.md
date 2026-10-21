# 争议案件访问

合同进入 `disputed` 后，当事人通过 `POST /api/disputes` 提交 `{contractId, confirmed: true}`，建立唯一案件，取得案件 `id`。本入口不改变合同状态。

当事人通过以下接口管理案件；使用现有登录 Cookie（写请求附带 `X-CSRF-Token`）或 Bearer 会话。Agent 不得创建案件、授权或提交证据。

- `POST /api/disputes/{id}/grants`：提交 `{adminId, scope: "audit_and_evidence:read", expiresAt, confirmed: true}`。`expiresAt` 为未来的毫秒时间戳。授权人必须是具有合同写入和委派权限的当事人；指定管理员必须具有平台管理员身份以及同组织、同项目的管理员成员关系。响应包含授权 ID、授权人、管理员、范围和到期时间。
- `POST /api/disputes/{id}/revoke`：提交 `{grantId}`。任一具有合同写入权限的当事人均可撤销该案件授权；重新授权产生新记录，保留原授权历史。
- `POST /api/disputes/{id}/evidence`：提交 `{eventSequence, confirmed: true}`。引用必须来自该合同的事件记录；双方分别明确提交，保留提交方与时间。普通里程碑提交不会自动成为案件证据。

获准管理员访问 `/disputes/{id}` 查看只读页面，或 `GET /api/disputes/{id}` 获取 JSON。没有全局案件列表。每次读取重新检查登录、成员关系、精确案件授权、撤销和有效期，并写入安全审计；审计写入失败时不返回案件内容。

案件视图只显示该合同及该案件的安全审计事件名称、结果、序号、时间，以及双方明确提交的合同事件引用。不会展开事件 payload、合同条款、交付物、仓库、凭据或身份详情；引用本身不授予源内容访问权限。审计、证据引用均按案件隔离。授权到期、撤销、不存在或跨案件访问统一返回 `403 FORBIDDEN / 无权访问`。

案件操作不会修改合同、里程碑、工作区或结算状态，不包含裁决、解冻与退款。数据库迁移 `0013_disputes.sql` 增加案件、授权历史和证据引用表；`dispute` 资源通过现有授权服务检查成员关系，精确授权从独立案件授权表读取，不生成合同或仓库资源授权。
