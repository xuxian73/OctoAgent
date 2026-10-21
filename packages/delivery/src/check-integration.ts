import { randomUUID } from "node:crypto";
import { ContainerExecutor, CheckResult } from "./executor.js";
const runtime = process.env.CHECK_INTEGRATION_RUNTIME || "/usr/bin/docker";
const image = process.env.CHECK_INTEGRATION_IMAGE || "";
const fixture = `set -eu
[ "$(id -u)" = 65534 ]
grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
[ "$(ls /sys/class/net)" = lo ]
[ ! -S /var/run/docker.sock ]
[ ! -e /host ]
if touch /root-write-test 2>/dev/null; then exit 21; fi
if touch /workspace/write-test 2>/dev/null; then exit 22; fi
[ "$(cat /sys/fs/cgroup/memory.max)" = 134217728 ]
[ "$(cat /sys/fs/cgroup/pids.max)" = 64 ]
[ "$(cat /sys/fs/cgroup/cpu.max)" = '50000 100000' ]
[ "$(ulimit -n)" = 128 ]
touch /tmp/allowed
printf 'PASS\\n'
`;
let verified = true;
for (const [kind, script, expected] of [
  ["boundaries", fixture, "succeeded"],
  ["nonzero", "exit 7\n", "failed"],
  ["timeout", "sleep 30\n", "timed_out"]
]) {
  const executor = new ContainerExecutor({
    runtime,
    image,
    commands: { test: ["/bin/sh", "/workspace/fixture.sh"] },
    timeoutMs: kind === "timeout" ? 1000 : 10000,
    outputBytes: 4096
  });
  const base: CheckResult = {
    id: randomUUID(),
    sha: "integration-fixture",
    kind: "test",
    version: 1,
    status: "queued",
    passed: false,
    simulated: false,
    exitCode: null,
    startedAt: null,
    endedAt: null,
    image: "",
    executor: "",
    command: [],
    log: "",
    truncated: false
  };
  const result = await executor.run(
    base,
    [{ path: "fixture.sh", bytes: Buffer.from(script!) }],
    new AbortController().signal
  );
  const passed = result.status === expected;
  verified = verified && passed;
  console.log(
    JSON.stringify({
      fixture: kind,
      status: result.status,
      exitCode: result.exitCode,
      image: result.image,
      verified: passed
    })
  );
}
console.log(
  verified
    ? "真实隔离容器集成通过（含网络、只读文件系统、权限与 cgroup v2 资源边界）"
    : "阻塞：未通过真实容器验证；检查预置镜像、运行时和 cgroup v2。未拉取镜像，未回退模拟执行。"
);
if (!verified) process.exitCode = 1;
