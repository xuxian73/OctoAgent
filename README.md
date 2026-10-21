# OctoAgent

可运行的 TypeScript monorepo、品牌化应用壳，以及账户、组织、项目与 Agent 服务端授权、需求草稿与确认发布；暂不接入第三方身份提供商。

## 本地启动

需要 Node.js **22.22.1**（`.nvmrc`）和 npm 10。首次安装需要访问 npm registry；安装完成后，构建、迁移和测试均不访问网络，不需要第三方账号或密钥。

```bash
nvm use
npm ci --no-audit --no-fund
cp .env.example .env
npm run db:migrate
npm run dev
```

访问 http://localhost:3000；`GET /api/health`返回 JSON 存活状态（不表示数据库就绪）。`npm run dev`先编译，再启动服务，不会自动监视文件变化；修改 TypeScript 后，按 Ctrl+C 停止服务并重新运行`npm run dev`，然后手动刷新浏览器。即使另开终端运行`npm exec -- tsc --watch`，服务端改动也需要手动重启服务才能生效。`npm run build && npm start` 可运行编译后的应用。所有命令从仓库根目录执行。

`.env` 只由启动/迁移命令读取，已被 Git 和 Docker 忽略。`DATABASE_URL` 为本地 SQLite 文件地址；`HOST`/`PORT` 为监听地址；`APP_URL` 预留为后续绝对 URL 的来源；`SESSION_SECRET` 仅预留，当前无会话功能，不要求填写。后续身份功能必须校验该密钥并仅在服务端使用。不要把真实凭据或个人数据加入测试、代码和日志。

## 技术栈与目录

需求第 7 节的 Next.js / Prisma 是默认建议。本次执行环境不能访问 npm，缓存中也没有这两个依赖，因此选择可离线验证的 Node.js 原生 HTTP、浏览器 DOM、TypeScript **5.9.3** 和 Node 内置 SQLite（该 Node 版本会显示实验性提示）。暂不引入框架、ORM 或 MCP SDK，避免在基线中加入无法验证的依赖。格式工具使用缓存可用的 Prettier **1.19.1**；依赖精确版本及完整性散列记录在 `package-lock.json`，统一使用 `npm ci` 安装。

- `apps/web`：应用壳渲染、品牌样式和浏览器交互；仅允许显式列出的静态资源。
- `apps/server`：HTTP 入口、健康检查和公共错误处理。
- `packages/shared`：浏览器/服务端共用的纯类型，不依赖数据库、环境变量或 Node API。
- `packages/database`：数据库接口、SQLite adapter、schema 和有序 SQL 迁移。
- `tests`：Node 内置测试运行器；不监听端口、不访问网络，数据库使用独立临时目录并在测试后删除。

这是 npm workspaces monorepo，统一由根 `tsconfig.json` 严格检查和编译。包间当前使用显式相对导入；浏览器导入的共享运行时模块通过显式静态资源白名单提供。后续模块可以在各 workspace 内增量扩展。

## 数据库边界与迁移

`npm run db:migrate` 显式应用迁移，开发服务器不会隐式迁移。路径相对仓库根目录，默认 `.data/octoagent.sqlite`。迁移按文件名排序，在事务中执行，记录 SHA-256，重复运行跳过已应用项；已应用文件被删除或修改会失败。当前包含基础设施表、迁移账本，以及 Issue #3 的身份、成员关系、授权资源引用、资源授权和凭据表。

新增结构时添加 `packages/database/migrations/NNNN_description.sql` 并更新 `schema/baseline.sql`（完整目标结构）；不要修改已经应用的迁移。迁移检查在全新临时库执行迁移、对比 schema、再次执行验证幂等性，并验证篡改检测。`db:check` 需先 `npm run build`。

服务端后续依赖 `Database` 接口，具体 SQL 留在 adapter 内。生产目标仍为 PostgreSQL：切换时需要新增 PostgreSQL adapter、驱动及独立的 PostgreSQL SQL 迁移，扩展连接工厂和相同契约测试；不是只改 URL，也不能复用 SQLite 文件或方言迁移。业务 repository 接口应随对应 issue 添加。

## Docker Compose

```bash
docker compose up --build
```

镜像安装依赖并构建，以非 root 用户启动；Compose 先执行迁移再启动服务，SQLite 保存在命名卷中，访问 http://localhost:3000。首次构建需要网络和 Docker。`docker compose down` 保留数据；显式 `docker compose down -v` 才会删除卷。该 Compose 为本地基线，生产 PostgreSQL 部署在后续 issue 实现。

## 可重复检查和 CI

```bash
./scripts/check.sh
```

依次执行格式检查、严格类型检查、清理并构建、迁移校验、全部离线测试；任一步失败均以非零状态退出，不使用 `--if-present` 跳过检查，不读取开发 `.env` 或操作开发数据库。缺依赖时明确失败；先按上述步骤安装。`npm run format` 可修复格式。

GitHub Actions 使用 `.nvmrc` 固定 Node，按 lockfile 缓存 npm，执行 `npm ci` 后调用同一个检查脚本。离线新环境需要预先准备与 lockfile 匹配的 npm 缓存，然后使用 `npm ci --offline --no-audit --no-fund`；空缓存不能凭空安装依赖。

## 共享类型与错误约定

API 使用 `ApiResult<T>` 判别联合：成功为 `{ ok: true, data, request_id }`；失败为 `{ ok: false, error: { code, message }, request_id }`。当前公共错误码为 `NOT_FOUND`（404）、`FORBIDDEN`（403）和 `INTERNAL_ERROR`（500）；HTTP header `X-Request-Id` 与响应 ID 一致，由服务端生成，不信任客户端传入 ID。内部异常不直接返回或记录，避免泄漏数据库地址、路径或凭据。共享 TypeScript 类型不是运行时校验，后续有输入的接口必须在服务端增加校验。

未来业务 API 和 MCP 需要在各自 issue 中扩展业务状态、下一步、摘要与人工确认字段；本次健康检查不是业务操作，不提前实现这些规则。

## 应用壳与状态演示（Issue #2）

访问 `/` 或 `/console` 呈现未登录提示；当前尚未接入认证。访问 `/preview` 可查看**公开、合成数据**的登录后布局，包含需求、报价、合同、工作区和验收入口，入口仅展示占位页，不执行业务动作。演示身份不会存储为会话，也不会授权任何 API。页面底部可切换加载、失败、权限不足、404、空数据和表单错误；表单仅在本地检查必填项，不保存内容。

`apps/web/tokens.css` 集中定义品牌颜色、字体、间距和形状；`app.css` 使用这些 tokens，并在 760px 以下改为单栏和两列关键操作。`src/shell.ts` 提供 Logo、状态页、Agent 动作摘要与服务端 HTML 渲染，输入组织名称和动作内容均转义。`src/main.ts` 只负责重试和演示表单交互。导航使用原生链接，表单支持键盘提交，提供跳转主内容链接、焦点样式及语义标签。

真实身份接入时，应由服务端提供 `Session`（组织上下文与权限），不得使用演示路由、URL 参数或浏览器存储作为身份依据。渲染器会过滤未授权入口和正文，但这不是业务授权层；后续每个业务 API 仍须独立验证会话、组织和对象权限。需求业务入口与接口见下方 Issue #4 说明。

离线测试覆盖 HTML 渲染、权限上下文、状态隔离、HTML 转义、导航路由、原生事件处理和响应式样式约束；不依赖浏览器下载或外部服务。

## 身份与授权（Issue #3）

`packages/auth` 是 HTTP 与后续 MCP 共用的服务端授权服务，依赖 `IdentityStore` 接口；SQLite 实现在 `packages/database/src/identity.ts`。迁移 `0002_identity.sql` 建立用户、组织、项目、成员角色、Agent、授权资源引用和凭据，不实现合同或工作区业务流程。Agent 必须绑定已存在的用户责任主体，记录 buyer/seller/orchestrator 类型和能力标签；能力标签不产生权限。责任主体不可原地变更，转移责任时必须建立新 Agent 并重新授权。

授权需要同时满足：有效凭据、当前组织成员关系、当前项目成员关系（项目内资源）、角色允许、该用户对该资源和动作的明确 grant。组织成员身份不会隐式授予项目权限；项目权限不会隐式授予任何合同或工作区。平台管理员可撤销凭据，但读取资源仍需成员关系和明确 grant。

| 成员角色        | read         | write        | delegate     |
| --------------- | ------------ | ------------ | ------------ |
| buyer（甲方）   | 需明确 grant | 需明确 grant | 需明确 grant |
| seller（乙方）  | 需明确 grant | 需明确 grant | 需明确 grant |
| admin（管理员） | 需明确 grant | 拒绝         | 需明确 grant |

Agent 还必须满足 token scope，不能执行 delegate。scope 结构为 `{ kind, resourceId, action }`，无通配符或父资源继承；默认空 scope，不能读取私有仓库、密钥、生产环境或其他合同。服务端调用方可以通过 `authorizeRequest(auth, request, scope, roles)` 或 `auth.authorize(token, scope, roles)` 进一步限制允许的角色。scope 必须由服务端路由/工具定义，不得直接采用客户端声称的所需权限。不可逆动作的人类确认仍由后续业务层实现，write grant 本身不替代确认。

`Authorization.issueUserSession` 仅供可信服务端在验证用户身份后调用，不是公开登录接口；当前无密码/OAuth 登录，也不会自动装载测试用户。`issueAgentToken` 只允许责任主体持有效用户会话签发，签发者必须同时持有目标动作及 delegate grant。Agent 凭据默认且最长 15 分钟，用户会话默认 1 小时、最长 8 小时。凭据用安全随机数生成，只在签发返回值中提供原文，数据库仅保存 SHA-256 摘要。每次请求重新读取过期、撤销、责任主体和当前权限，不缓存成功身份。`revoke(session, tokenDigest)` 持久化撤销；撤销者须是责任主体或平台管理员。可注入审计回调只接收事件类型和 token 摘要，不接收原始凭据。不可篡改审计存储属于后续审计 issue。

`GET /api/access/{kind}/{id}` 是只读的授权元数据接口，用于验证接入；允许的 kind 为 organization/project/contract/workspace/repository/secret/production。要求且仅允许一个 `Authorization: Bearer …` 请求头，成功返回身份、资源引用及角色，不返回业务内容。不存在、越权、缺凭据、过期和撤销均返回相同的 403 `FORBIDDEN / 无权访问`。响应禁止缓存；客户端 request ID、用户和角色头不作为身份依据。重复读取允许，但每次重新鉴权并生成新的服务端 request ID；写操作幂等和回调重放防护留给对应业务与审计 issue。公开 preview 仍只使用合成数据。

`tests/fixtures/identity.ts` 提供可复用的两个组织、甲乙双方、管理员、Agent 和明确资源 grant，不包含固定凭据。测试在内存或独立临时 SQLite 中执行，运行时生成凭据；不向开发数据库写入种子主体。

## 需求草稿与发布（Issue #4）

访问 `/requirements` 使用结构化表单创建、保存和按 ID 加载草稿。复用 Issue #3 的可信会话签发边界：输入已签发的甲方会话和明确授权的项目 ID；本 issue 不增加登录提供商或自动创建身份。凭据不写浏览器存储、URL、日志或测试种子。所有数据请求由服务端重新验证甲方角色、组织/项目成员关系及项目 read/write grant。Agent 可以在授权范围内编辑草稿，但不能取得发布确认或发布。

表单覆盖 8 种任务类型、3 种预算方式，唯一结算币种为 CNY；按小时金额表示时薪，按里程碑填写总额及里程碑分配说明。草稿允许缺失，保存后返回缺失字段和风险提示；发布要求全部字段完整、金额有效。没有仓库、权限等情况请明确填写“无”。里程碑分配和验收条款目前为文本，由甲方在摘要中审核。

所有自由文本默认私密，逐字段勾选才允许进入公开快照。发布前返回范围、预算、交付物、验收标准及附件摘要；确认凭证绑定人类身份、草稿修订号和 10 分钟有效期。修改文字、公开标记或添加附件都会使旧确认失效。第一次确认发布生成版本 1；后续先保存待发布编辑，再重新确认生成递增版本。编辑期间公开视图继续返回上次确认的快照。修订号 CAS 拒绝并发覆盖，确认发布不可重放。

`0003_requirements.sql` 保存草稿、公开快照、变更字段名和发布者，以及报价参与者与通知事件。变更记录不存文本原文。每次后续发布与版本记录、每位参与报价者的 `requirement_changed` 事件在同一事务提交；通知失败则整体回滚。`requirement_participants` 仅供后续报价服务在可信事务内登记，没有公开订阅/冒充报价接口。本 issue 不发送邮件、不实现报价业务。

附件仅登记元数据，不接收、存储或提供文件内容下载。服务端限制为 1 字节至 10 MiB，允许 PDF/TXT/PNG/JPG 的 MIME 与扩展名组合，拒绝路径名称和不支持类型。默认私密；私密附件元数据仅项目授权甲方可读。明确公开的元数据也要等重新确认发布后才进入公开快照。没有真实文件上传，因此不声称完成内容嗅探或病毒扫描。

API（JSON 请求，除 public 外均要求唯一 Bearer 请求头）：

| 路径                                                | 方法      | 用途                                                      |
| --------------------------------------------------- | --------- | --------------------------------------------------------- |
| `/api/requirements`                                 | POST      | `{ projectId, draft: { values, publicFields } }` 创建草稿 |
| `/api/requirements/{id}`                            | GET / PUT | 读取；用 `{ revision, draft }` 保存                       |
| `/api/requirements/{id}/preview`                    | POST      | 校验并取得结构化摘要和确认凭证                            |
| `/api/requirements/{id}/publish`                    | POST      | `{ confirmation, confirmed: true }` 确认发布              |
| `/api/requirements/{id}/public`                     | GET       | 只读已发布且明确允许公开的字段与附件元数据                |
| `/api/requirements/{id}/attachments`                | POST      | `{ name, mime, size, private? }` 登记元数据               |
| `/api/requirements/{id}/attachments/{attachmentId}` | GET       | 授权读取元数据                                            |

`tests/requirements.test.ts` 离线覆盖字段/枚举、确认与重放、过期与身份绑定、两连接并发、通知事务回滚、重开数据库、附件边界、租户权限与 HTTP 输入校验。服务端不记录请求体、附件名称或内部异常原文。

### 需求发现与报价（issue #5）

- `/requirements` 中启用发现设置，填写报价截止时间、周期、风险与 Agent 开关，并明确公开必要的任务上下文字段；设置随人工确认的发布版本生效。旧需求默认不进入发现列表。
- `/market` 使用当前会话与授权项目 ID 搜索需求、起草报价、确认提交、撤回、补充说明、比较与澄清。沿用项目成员身份和精确资源授权，平台管理员不获得默认读取权；Agent 还需对应项目 read/write scope。
- 每次保存报价创建不可变的新版本。责任人查看摘要后获得十分钟有效的确认凭据，提交绑定报价及需求版本；同一确认重试不会重复创建事件。Agent 可起草和撤回，承诺报价由责任人本人确认提交。
- 比较只取每位责任人最新的非草稿版本；撤回最新版本不会自动恢复旧报价。默认按风险、周期排序，可切换周期、能力标签数量或价格；能力标签为报价方自述，不是平台评级。历史报价保留所引用的需求版本，需求重新发布后应重新报价。
- 定向问题仅甲方与指定报价方可见；全部报价方问题对已提交报价的参与者可见。回答和补充说明仅甲方与对应责任人可见。时间线以时间、事件序号稳定排序，澄清不修改需求范围。
- API 前缀 `/api/market`：GET 列表（`projectId`、`stack`、`taskType`、`budgetType`、`maxDays`、`deadlineAfter`、`risk`、`allowAgents`），GET `/:taskId`、`/:taskId/bids`、`/:taskId/compare`、`/:taskId/timeline`；POST `/:taskId/bids`、`/:taskId/questions`、`/:taskId/answers` 和 `/bids/:bidId/{preview,submit,withdraw,supplements}`。请求体为 JSON，凭据仅通过 Authorization header 传递。

### 合同、变更与验收（issue #6）

访问 `/contracts`，从 `/market` 复制已提交报价 ID，甲方勾选人工确认后生成合同草案。每个需求最多选定一份合同；报价、需求版本及公开范围随选择事件保存。合同只授予甲乙责任人精确的 contract read/write/delegate grant，仍验证组织和项目成员关系；Agent 另需合同 scope。平台管理员没有默认读取权。

- 草案 `draft → pending_confirmation` 后，双方人类责任人分别确认同一版本才进入 `active`。双方确认使用版本号而非修订号，允许同时确认；其他命令携带修订号，拒绝过期界面操作。
- 合法合同操作：draft 可提交确认或取消；pending_confirmation 可取消或争议；active 可暂停、完成、取消或争议；paused 可恢复、取消或争议。完成要求当前版所有里程碑已验收且由甲方操作。completed、cancelled、disputed 无普通出边；本 issue 不实现争议裁决或解冻。
- 任一方可在 active/paused 提出变更，生成不可覆盖的新条款版本并进入 pending_confirmation。旧条款、确认、里程碑与事件仍可读。新版本创建新的 planned 里程碑，必须重新交付验收，不继承旧版验收结果。
- 乙方推进 planned → in_progress → submitted；甲方对 submitted 验收 accepted、要求修改 changes_requested 或拒绝 rejected。changes_requested 可重新开始或重新提交；accepted/rejected 是本版本终态。提交必须附证据；所有命令必须填写 `{ code, detail }` 结构化原因。争议通过合同状态操作发起，冻结所有后续写命令。
- 买方 Agent 仅可保存 `acceptance_report_draft`，不改变里程碑状态；验收事件另标记人工最终确认。结算起始为 unsettled，完成后甲方可登记 manually_confirmed，仅作人工记录，不调用支付、托管或放款。

API 均要求唯一 Bearer 请求头，JSON 请求体上限 200 KB：

- `POST /api/contracts/select`：`{ bidId, confirmed: true }`。
- `GET /api/contracts/{id}`：合同、历次条款、全部里程碑、双方确认和审计时间线。
- `POST /api/contracts/{id}/commands`：公共字段 `{ action, version, revision, requestKey, confirmed: true, reason: { code, detail } }`。action 为 transition（另传 to）、confirm、change（另传完整 terms）、milestone（milestoneId、to，提交时附 evidence）、review_draft（milestoneId、report，不要求人工确认）、settlement。

terms 包含 scope、deliverables、acceptance、changeRules、price、currency（CNY）及 milestones 字符串数组。相同责任人同一 requestKey 的同体重试只读取最新结果，不重复执行；变更请求体却复用 key 返回冲突。状态、版本、确认、幂等记录和审计事件在 `BEGIN IMMEDIATE` 事务内写入；旧条款与审计事件有禁止更新/删除的数据库触发器。测试包含独立 SQLite worker 并发确认与重复提交、HTTP 和浏览器交互、事务回滚、版本隔离、Agent 限权与争议冻结。

### Marketplace MCP（issue #8）

`/mcp` 提供官方 TypeScript SDK 的 Streamable HTTP 接口，支持全部工具、八个资源 URI 模板和三个提示词。使用短期 Agent Bearer Token，详见 [MCP 接口与人工确认协议](docs/mcp.md)。不可逆工具仅返回待人工确认范围，业务 API 保持最终权限与状态校验。
