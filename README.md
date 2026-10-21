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

`.env` 只由启动/迁移命令读取，已被 Git 和 Docker 忽略。`DATABASE_URL` 为本地 SQLite 文件地址；`HOST`/`PORT` 为监听地址；`APP_URL` 预留为后续绝对 URL 的来源；`NODE_ENV=production` 强制浏览器会话 Cookie 使用 Secure，生产入口必须通过 HTTPS。会话使用安全随机数，不需要共享 SESSION_SECRET。不要把真实凭据或个人数据加入测试、代码和日志。

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

访问 `/login` 登录本地账号，`/` 或 `/console` 根据真实 Cookie 会话显示业务入口或登录提示。访问 `/preview` 可查看**公开、合成数据**的登录后布局，包含需求、报价、合同、工作区和验收入口，入口仅展示占位页，不执行业务动作。演示身份不会存储为会话，也不会授权任何 API。页面底部可切换加载、失败、权限不足、404、空数据和表单错误；表单仅在本地检查必填项，不保存内容。

`apps/web/tokens.css` 集中定义品牌颜色、字体、间距和形状；`app.css` 使用这些 tokens，并在 760px 以下改为单栏和两列关键操作。`src/shell.ts` 提供 Logo、状态页、Agent 动作摘要与服务端 HTML 渲染，输入组织名称和动作内容均转义。`src/main.ts` 只负责重试和演示表单交互。导航使用原生链接，表单支持键盘提交，提供跳转主内容链接、焦点样式及语义标签。

真实控制台入口由服务端验证 Cookie，业务数据继续按组织、项目与资源权限校验；不得使用演示路由、URL 参数或浏览器存储作为身份依据。渲染器会过滤未授权入口和正文，但这不是业务授权层；后续每个业务 API 仍须独立验证会话、组织和对象权限。需求业务入口与接口见下方 Issue #4 说明。

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

`Authorization.issueUserSession` 仅供可信服务端在验证用户身份后调用，不是公开登录接口；本地密码登录在验证密码后调用此接口，不提供 OAuth，也不会自动装载测试用户。`issueAgentToken` 只允许责任主体持有效用户会话签发，签发者必须同时持有目标动作及 delegate grant。Agent 凭据默认且最长 15 分钟，用户会话默认 1 小时、最长 8 小时。凭据用安全随机数生成，只在签发返回值中提供原文，数据库仅保存 SHA-256 摘要。每次请求重新读取过期、撤销、责任主体和当前权限，不缓存成功身份。`revoke(session, tokenDigest)` 持久化撤销；撤销者须是责任主体或平台管理员。可注入审计回调只接收事件类型和 token 摘要，不接收原始凭据。不可篡改审计存储属于后续审计 issue。

`GET /api/access/{kind}/{id}` 是只读的授权元数据接口，用于验证接入；允许的 kind 为 organization/project/contract/workspace/repository/secret/production。要求且仅允许一个 `Authorization: Bearer …` 请求头，成功返回身份、资源引用及角色，不返回业务内容。不存在、越权、缺凭据、过期和撤销均返回相同的 403 `FORBIDDEN / 无权访问`。响应禁止缓存；客户端 request ID、用户和角色头不作为身份依据。重复读取允许，但每次重新鉴权并生成新的服务端 request ID；写操作幂等和回调重放防护留给对应业务与审计 issue。公开 preview 仍只使用合成数据。

`tests/fixtures/identity.ts` 提供可复用的两个组织、甲乙双方、管理员、Agent 和明确资源 grant，不包含固定凭据。测试在内存或独立临时 SQLite 中执行，运行时生成凭据；不向开发数据库写入种子主体。

## 需求草稿与发布（Issue #4）

访问 `/requirements` 使用结构化表单创建、保存和按 ID 加载草稿。先在 `/login` 登录，再从组织 / 项目列表选择明确授权的项目；浏览器自动发送 HttpOnly Cookie，并从当前身份接口获取仅存内存的 CSRF 校验值。凭据不写浏览器存储、URL、日志或测试种子。所有数据请求由服务端重新验证甲方角色、组织/项目成员关系及项目 read/write grant。Agent 可以在授权范围内编辑草稿，但不能取得发布确认或发布。

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

## 离线端到端演示与种子（issue #10）

从干净环境使用 Node.js 22.22.1 / npm 10，在仓库根目录执行：

```bash
npm ci --offline --no-audit --no-fund  # 需要事先准备与 lockfile 匹配的 npm 缓存
npm run demo:seed
npm run test:e2e
./scripts/check.sh
```

没有缓存时首次使用 `npm ci --no-audit --no-fund` 安装；此后种子、构建和所有检查均离线，不需要第三方账号。`npm run demo:seed` 一条命令完成编译、真实迁移、合成身份/需求/报价、合同及 fake Git 工作区初始化，并运行模拟 Agent 交付验收。默认输出到 `.data/demo/`；可用 `npm run demo:seed -- /tmp/octo-demo` 指定独立目录。命令不读取 `.env` 或 `DATABASE_URL`，不操作开发数据库。

演示包含甲乙责任主体、买卖双方 Agent、另一位报价方及隔离租户。两个代码需求分别演示“人工发布 → 两份结构化报价比较 → 人工选标 → 双方确认合同 → 独立授权交付 → 要求修改 → 再次提交 → 人工验收完成”和“提交后争议冻结”。模拟驱动明确扮演人类责任主体，通过业务 HTTP API 执行确认；MCP Agent 只产生确认交接，不能自动确认。凭据运行时生成、只保存在进程内，完成后全部撤销；不会打印或导出凭据。

产物：

- `demo.sqlite`：经项目迁移初始化的 SQLite，保存合成业务数据、版本、确认记录和不可篡改审计。
- `report.json`：每次 API/MCP 请求的 `request_id`、结果及对应审计事件序号，包含确认过期、越权和冻结错误。
- `repositories.json`：每份合同的本地 fake Git 仓库快照，包含分支、提交、检查、模拟 PR、制品 SHA-256、两次交付和审计引用对应的合同事件。沿用 `FakeGitHubProvider`，仓库状态持久化在 SQLite；不是磁盘上的 `.git`，不执行仓库代码，不连接 GitHub。模拟 PR 的 `.invalid` 地址仅为证据标识。

重复运行会读取同一完成记录并重新导出证据，不增加用户、需求、合同、提交或审计事件。种子写入与完成记录使用同一事务，失败整体回滚，可再次执行。已有非演示用户的数据库会被拒绝。需要全新演示时指定一个新的空目录；演示使用注入时钟验证过期，不等待真实时间。

`tests/e2e.test.ts` 使用临时目录，结束后清理；HTTP 请求直接经过应用 dispatcher/解析器，MCP 使用 SDK 内存传输，不监听端口或访问网络。测试验证关键页面、草稿缺失提示、每个业务状态、人工确认、只读与写入 scope、交付动作分别授权、跨租户隐藏、验收前无结算/生产变更，以及争议后的冻结。它是离线应用集成验收，不是浏览器自动化或真实 GitHub 检查。`./scripts/check.sh` 自动包含此测试，CI 无需新增服务或网络资源。

## 本地账号与浏览器登录（Issue #21）

部署者先执行 `npm run db:migrate`，然后在服务器终端离线建号（示例名称仅为占位）：

```sh
python3 -c 'import getpass; print(getpass.getpass("Password: "))' | npm run account:create -- account-name user-id
```

命令从标准输入读取密码，不接受命令行密码或环境变量密码；输入不回显，也不进入 shell 历史。账号名为 1–64 位字母、数字、下划线、点或连字符，密码为 12–256 个字符。数据库专用认证表仅保存随机盐和 scrypt 散列（N=32768、r=8、p=1，64 字节）；不会修改已有密码。用户 ID 可绑定已有身份，也可新建普通成员；建号不会赋予任何组织成员关系或资源权限。按现有部署流程单独配置授权，无开放注册接口。

`POST /api/auth/login` 接受 JSON，并要求 `X-Octo-Login: 1`；登录页自动完成。`GET /api/auth/me` 返回当前用户与 CSRF 值，不返回会话原文。`POST /api/auth/logout` 撤销当前会话并清除 Cookie。Cookie 为 HttpOnly、SameSite=Strict、Path=/ 的浏览器会话 Cookie（不设置持久化有效期），服务端会话 1 小时过期；生产设置 `NODE_ENV=production` 并通过 HTTPS 提供服务。不得在代理访问日志中记录请求体、Authorization 或 Cookie。

Cookie 写请求必须带当前身份接口提供的 `X-CSRF-Token`；该值与会话绑定，只存在页面内存。Web API 仍兼容原有 Bearer 客户端，MCP 仅接受 Bearer；同时提供会话 Cookie 与 Authorization、重复会话 Cookie 或重复 Authorization 会被拒绝。登录不启用 CORS，跨站登录请求被拒绝。

登录每个 TCP 来源地址每分钟最多 5 次尝试（包含成功），最多保留 1024 个来源窗口，最多并发 4 个验证请求，超限返回 429；不信任转发 IP 头。此限流适用于当前单进程部署，重启会重置，多实例或反向代理部署应在入口额外配置共享限流。审计仅记录登录结果、请求 ID，以及现有会话签发/撤销摘要，不记录输入账号、密码、Cookie 或 CSRF 原文。

## 首次使用与项目上下文（Issue #22）

完成本地账号登录后，无项目的新账户从控制台进入 `/onboarding`。填写组织和项目名称后，一次创建组织、项目及两级甲方成员关系，仅授予组织 read 和项目 read/write，随后进入需求草稿页面。已有项目成员关系的账户不能初始化；初始化记录永久保留，撤销成员或 grant 后不会重新开放创建入口。

- `POST /api/onboarding`：仅接受人类身份，JSON 为 `{ "organizationName": "组织名称", "projectName": "项目名称" }`，名称不能为空且最长 80 字符；不接受用户 ID、角色或额外授权字段。必须提供 `Idempotency-Key`，Cookie 请求同时要求 CSRF。
- `GET /api/contexts`：返回当前用户获准读取的 `organizations`、`projects` 和 `canInitialize`。名称缺失的既有组织、项目使用 ID 显示；每次查询重新检查成员与显式 read grant。
- 创建、授权、审计和幂等记录在同一事务内提交。相同 key 与请求体返回原结果，变更请求体或再次初始化返回 409；重放仍校验当前授权。名称不写入审计。

部署时运行现有迁移命令应用 `0012_onboarding.sql`。无需通过 SQL 或演示种子建立首个组织和项目。

## 责任主体管理 Agent（Issue #24）

登录后从“我的 Agent”进入 `/agents`，创建买方、卖方或平台编排 Agent，并填写能力标签。责任主体固定为当前人类账户；类型和标签不授予权限。页面只提供本人同时拥有动作权限和 delegate grant 的 scope，签发前显示责任主体、Agent、精确 scope 和有效分钟数，必须人工确认。

- `GET /api/agents`：列出本人 Agent、可委派 scope、最长有效期和凭据记录。
- `POST /api/agents`：JSON 为 `{ "kind": "seller", "capabilities": ["typescript"] }`，不接受责任主体字段。
- `POST /api/agents/:id/credentials`：接受 `scopes`、`ttlMs` 和 `confirmed: true`；有效期必须为正整数毫秒且不超过 900000，服务端重新检查每项动作权限及 delegate grant。
- `DELETE /api/agents/:id/credentials/:credentialId`：撤销本人 Agent 的凭据，下次 MCP 请求立即失败。Agent 身份不能使用上述管理接口。

Cookie 写请求沿用 CSRF 校验。签发响应禁止缓存，原文凭据只在本次结果中展示；将其配置到 MCP 客户端的 `Authorization: Bearer` 请求头，连接本部署的 `/mcp`（协议见 [MCP 文档](docs/mcp.md)）。列表只返回摘要标识、scope、到期时间和撤销状态，审计不保存原文。页面提供“清除原文”；刷新后无法找回。签发不重放或缓存原文结果，响应丢失时先从列表撤销对应凭据，再重新确认签发；不提供自动续期。

## 真实本地文件扫描（#40）

`POST /api/files` 在 SQLite 提交实际字节后调用本机 ClamAV。状态为 `quarantined → scanning → clean / rejected / unavailable`。扫描器名称、开始/完成时间及扫描 checksum 由服务端记录；客户端字段不能指定放行状态。已有扫描结论在迁移时全部退回隔离，须重新扫描。普通下载和工作区文件制品绑定/提交均重新检查当前字节、大小、checksum、扫描 checksum 和非模拟结果；旧结果或模拟扫描不放行。当前仓库只有模拟 Git provider，没有真实 Git 导入入口；以后接入导入时必须通过同一个 `Files.download` 放行检查读取字节。

部署者需自行安装 `clamscan` 和本地病毒特征库（通常由部署环境的 `freshclam` 更新）。通过 `.env` 设置 `CLAMAV_EXECUTABLE` 为可信可执行文件的绝对路径，`CLAMAV_TIMEOUT_MS` 为 1–60000 毫秒，默认 30000。应用不下载病毒库、不访问在线扫描服务、不接受请求中的命令或宿主文件路径。默认 Docker 镜像未安装 ClamAV，需在部署镜像安装依赖及提供可读取的病毒库；否则扫描明确为 `unavailable`。

扫描以无 shell 子进程的标准输入接收数据库读回的字节，参数固定，限制输入 10 MiB、输出 64 KiB，超时强制终止。返回码 0 为 clean，1 为 rejected，其他退出、缺少程序/病毒库、超时和异常均为 unavailable。不输出扫描器原始日志。ZIP 只允许隔离保存，不解包、不认证归档内容，真实适配器返回 rejected。

上传同步等待一次有界扫描，因此单进程请求可能等待最多配置的超时时间。失败后可在文件列表重试，或由有当前版本写权限的调用者发送 `POST /api/files/:id/scan`（无需请求体）。同一文件的活动扫描通过数据库原子认领互斥；超过两分钟的遗留 scanning 可重新认领，尝试 ID 防止旧进程回写。重试期间禁止读取。重放上传不会重新扫描已完成对象。只读用户不能重试。`GET /api/health` 的 `fileScanner` 用固定无私密数据探针报告 available/unavailable，不包含路径、版本输出或上传内容；健康状态不是任何上传对象的放行凭据。

独立真实联调命令：

```sh
npm run scan:integration
```

该命令实际运行配置的 ClamAV，将临时文件读回后扫描：普通文本必须 clean，标准 EICAR 测试样本必须 rejected。临时文件随后删除。两项符合才报告真实联调通过；缺依赖或病毒库、超时、结果不符时以退出码 1 报告“未验证”。此命令不属于离线默认检查，也不会安装依赖。

`./scripts/check.sh` 的扫描测试使用明确注入的可控适配器和临时进程 fixture，覆盖状态、真实临时字节、超时、退出码、重试、扫描对象校验、租约及旧结果回写防护。它们验证集成逻辑，**不能作为真实 ClamAV 扫描成功的证明**。历史演示种子显式注入模拟扫描器，仍为模拟演示；应用默认不使用 FakeScanner。

隔离检查执行器的独立 worker、部署约束和真实容器集成命令见 [隔离检查服务](docs/isolated-checks.md)。默认离线测试不代表真实容器隔离验收通过。
