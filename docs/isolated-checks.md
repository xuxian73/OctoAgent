# 隔离检查执行服务（#42）

Web 与 MCP `run_check` 共用 Workspaces 授权入口，只接受合同版本、完整 SHA、`test` / `typecheck` 和幂等键。真实 Git 检查先入持久队列；Web 不启动运行时、不运行仓库代码。网页可选择提交、排队、取消并刷新证据。部署者必须单独启动 worker，且只向 worker 开放容器运行时；Web 不应拥有 Docker socket 或运行时权限。

## 部署

先运行既有数据库迁移和 `npm run build`。worker 使用同一 SQLite 数据库及 `GIT_REPOSITORY_ROOT`（同机本地可信存储），独立执行：

```sh
npm run check:worker
# 单次处理一个任务，便于运维调度
npm run check:worker -- --once
```

仅在 worker 环境设置 `CHECK_EXECUTOR_CONFIG`，例如（image 必须换成部署者已预置、已审查镜像的实际完整 image ID）：

```json
{
  "runtime": "/usr/bin/docker",
  "image": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "commands": {
    "test": ["/usr/local/bin/node", "/workspace/test.js"],
    "typecheck": ["/usr/local/bin/tsc", "--noEmit"]
  },
  "timeoutMs": 60000,
  "outputBytes": 16384
}
```

配置是部署者信任边界，不能由任务、仓库文件、网页、MCP 或上传内容修改。运行时须为可信 Docker CLI，连接本机受控 daemon；不支持任意 runtime 参数、挂载、环境变量或网络配置。镜像必须无秘密、无宿主挂载依赖，包含离线检查所需依赖；执行器拒绝声明 VOLUME 的镜像，防止匿名可写卷绕过只读文件系统。运行时使用空 HOME / Docker 配置和最小环境，不继承宿主令牌。没有运行时、镜像、合法配置或运行条件时记录 `unavailable`；不安装依赖、不拉镜像、不回退宿主或 FakeGitHubProvider。

容器固定 `--pull=never`、无网络、只读根与 Git 快照、非 root UID/GID、丢弃全部 capabilities、禁止新增权限；限制为 128 MiB 内存（不额外 swap）、0.5 CPU、64 PID、128 文件描述符和 16 MiB 临时目录；运行最多 300 秒、输出最多 64 KiB。使用独立命令 argv 和固定 entrypoint；仓库代码仅在容器内运行。受信镜像、运行时和内核仍属于部署信任边界。

Git 快照通过 Git 对象读取逐项导出，不执行 checkout、hooks、filter；拒绝符号链接、子模块、特殊文件及危险路径。绑定完整 SHA、仓库 generation、合同版本，导出最多 1000 文件 / 20 MiB。结果包含执行器、镜像 ID、命令、时间、退出码、状态与截断标记。容器退出状态取自 daemon inspect，不能靠日志中的 PASS 判定。原始输出仅在有界内存暂存，日志仅保留整行 PASS / FAIL / OK，其余隐藏；这是一项有意的诊断能力限制。

## 生命周期

同幂等键返回原请求；同合同/SHA/版本/类型的未完成请求合并。终态后以新请求键显式重试会生成新记录。读操作展示最新真实记录；新 SHA、旧合同版本、非 active 合同不能表示当前通过。模拟历史保持模拟，不能变成真实检查。

worker 在开始、运行中（每 100ms）和发布前重查原凭据 digest 的有效性、主体授权、Agent scope/委托、独立 check 权限及合同版本/active 状态；失效则取消。数据库不保存原 token。取消 queued 请求不执行；取消 running 请求终止并删除容器，终态取消幂等。失败、超时、取消、不可用、排队和运行中均不通过。worker 不在线时请求停留 queued，明确未完成。

正常终态强制删除容器并删除临时快照，清理失败不能发布成功。每次 claim 的租约为 6 分钟；worker 崩溃后，恢复的 worker 清理过期 running 容器并将尝试标记 unavailable，绝不重用旧成功结果。部署须持续运行 worker，并用服务管理器在崩溃后重启；强制杀死 worker/daemon 时无法保证立即清理；恢复时按执行 ID 清理容器与快照，清理失败会保留租约供后续重试。需运维监控 `octo-check-*` 容器及系统临时目录。不可用记录不是隔离通过的证据。

## 验证

```sh
./scripts/check.sh
```

默认检查完全离线。真实 Git 测试使用受控 CLI 协议 fixture 验证 argv、快照字节、结果解析、成功/失败、超时、取消、撤权、日志截断、幂等和 SHA 绑定；该 fixture **不提供容器隔离证明**。

独立真实集成（需要本机 Docker、cgroup v2，以及已预置包含 `/bin/sh`、基本 BusyBox/POSIX 工具的可信 Linux 镜像）：

```sh
CHECK_INTEGRATION_RUNTIME=/usr/bin/docker \
CHECK_INTEGRATION_IMAGE=sha256:<实际的64位镜像ID> \
npm run check:integration
```

此命令实际运行成功、非零退出、超时 fixture；在容器内检查 UID、capabilities、no-new-privileges、只有 loopback 网络接口、根目录和快照不可写、无 Docker socket，以及 cgroup 内存/PID/CPU 和文件描述符限制。任何依赖缺失或边界不符都以非零退出并报告阻塞，不静默跳过。默认离线测试通过不能描述成真实容器集成通过。
