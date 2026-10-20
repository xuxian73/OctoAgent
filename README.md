# OctoAgent

Issue #1 的可运行 TypeScript monorepo 基线；暂不包含登录、业务流程或外部服务。

## 本地启动

需要 Node.js **22.22.1**（`.nvmrc`）和 npm 10。首次安装需要访问 npm registry；安装完成后，构建、迁移和测试均不访问网络，不需要第三方账号或密钥。

```bash
nvm use
npm ci --no-audit --no-fund
cp .env.example .env
npm run db:migrate
npm run dev
```

访问 http://localhost:3000；`GET /api/health`返回 JSON 存活状态（不表示数据库就绪）。`npm run dev`先编译，再监视编译产物；修改 TypeScript 时另开终端运行`npm exec -- tsc --watch`，浏览器手动刷新。`npm run build && npm start` 可运行编译后的应用。所有命令从仓库根目录执行。

`.env` 只由启动/迁移命令读取，已被 Git 和 Docker 忽略。`DATABASE_URL` 为本地 SQLite 文件地址；`HOST`/`PORT` 为监听地址；`APP_URL` 预留为后续绝对 URL 的来源；`SESSION_SECRET` 仅预留，当前无会话功能，不要求填写。后续身份功能必须校验该密钥并仅在服务端使用。不要把真实凭据或个人数据加入测试、代码和日志。

## 技术栈与目录

需求第 7 节的 Next.js / Prisma 是默认建议。本次执行环境不能访问 npm，缓存中也没有这两个依赖，因此选择可离线验证的 Node.js 原生 HTTP、浏览器 DOM、TypeScript **5.9.3** 和 Node 内置 SQLite（该 Node 版本会显示实验性提示）。暂不引入框架、ORM 或 MCP SDK，避免在基线中加入无法验证的依赖。格式工具使用缓存可用的 Prettier **1.19.1**；依赖精确版本及完整性散列记录在 `package-lock.json`，统一使用 `npm ci` 安装。

- `apps/web`：最小启动页和浏览器 TypeScript；仅允许显式列出的静态资源。
- `apps/server`：HTTP 入口、健康检查和公共错误处理。
- `packages/shared`：浏览器/服务端共用的纯类型，不依赖数据库、环境变量或 Node API。
- `packages/database`：数据库接口、SQLite adapter、schema 和有序 SQL 迁移。
- `tests`：Node 内置测试运行器；不监听端口、不访问网络，数据库使用独立临时目录并在测试后删除。

这是 npm workspaces monorepo，统一由根 `tsconfig.json` 严格检查和编译。包间当前使用显式相对导入；浏览器只导入共享类型，编译后会被擦除。后续模块可以在各 workspace 内增量扩展。

## 数据库边界与迁移

`npm run db:migrate` 显式应用迁移，开发服务器不会隐式迁移。路径相对仓库根目录，默认 `.data/octoagent.sqlite`。迁移按文件名排序，在事务中执行，记录 SHA-256，重复运行跳过已应用项；已应用文件被删除或修改会失败。当前只有基础设施表 `platform_metadata` 和迁移账本，没有业务表或权限规则。

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

API 使用 `ApiResult<T>` 判别联合：成功为 `{ ok: true, data, request_id }`；失败为 `{ ok: false, error: { code, message }, request_id }`。当前公共错误码为 `NOT_FOUND`（404）和 `INTERNAL_ERROR`（500）；HTTP header `X-Request-Id` 与响应 ID 一致，由服务端生成，不信任客户端传入 ID。内部异常不直接返回或记录，避免泄漏数据库地址、路径或凭据。共享 TypeScript 类型不是运行时校验，后续有输入的接口必须在服务端增加校验。

未来业务 API 和 MCP 需要在各自 issue 中扩展业务状态、下一步、摘要与人工确认字段；本次健康检查不是业务操作，不提前实现这些规则。
