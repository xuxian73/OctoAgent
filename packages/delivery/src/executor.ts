import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { safePath } from "./github.js";

export type CheckStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unavailable";
export interface CheckResult {
  id: string;
  sha: string;
  kind: string;
  version: number;
  status: CheckStatus;
  passed: boolean;
  simulated: false;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
  image: string;
  executor: string;
  command: string[];
  log: string;
  truncated: boolean;
  cleanupPending?: boolean;
  isolation?: {
    network: "none";
    readOnly: true;
    uid: 65534;
    memoryBytes: number;
    cpus: number;
    pids: number;
    timeoutMs: number;
    outputBytes: number;
  };
}
export interface ExecutorConfig {
  runtime: string;
  image: string;
  commands: Record<string, string[]>;
  timeoutMs: number;
  outputBytes: number;
}
export function executorConfig(): ExecutorConfig {
  return JSON.parse(process.env.CHECK_EXECUTOR_CONFIG || "null");
}
export function validConfig(c: ExecutorConfig | null): c is ExecutorConfig {
  return (
    !!c &&
    Object.keys(c)
      .sort()
      .join() === "commands,image,outputBytes,runtime,timeoutMs" &&
    typeof c.runtime === "string" &&
    isAbsolute(c.runtime) &&
    /^sha256:[a-f0-9]{64}$/.test(c.image) &&
    Number.isSafeInteger(c.timeoutMs) &&
    c.timeoutMs >= 10 &&
    c.timeoutMs <= 300000 &&
    Number.isSafeInteger(c.outputBytes) &&
    c.outputBytes >= 64 &&
    c.outputBytes <= 65536 &&
    !!c.commands &&
    Object.entries(c.commands).every(
      ([k, v]) =>
        ["test", "typecheck"].includes(k) &&
        Array.isArray(v) &&
        v.length > 0 &&
        v.length <= 32 &&
        v.every(s => typeof s === "string" && s.length <= 1024) &&
        isAbsolute(v[0]!)
    )
  );
}
// Keep only a tiny, explicit vocabulary from untrusted output. Regex masking cannot
// guarantee absence of arbitrary personal data or encoded secrets.
function safeLog(raw: string) {
  return raw
    .split(/\r?\n/)
    .map(line =>
      /^(PASS|FAIL|OK)$/.test(line) ? line : line ? "[output redacted]" : ""
    )
    .join("\n");
}
/** Only the standalone worker imports and invokes this adapter in production. */
export class ContainerExecutor {
  constructor(private config: ExecutorConfig | null) {}
  cleanup(id: string) {
    if (!validConfig(this.config) || !/^[a-f0-9-]{36}$/.test(id)) return false;
    const root = mkdtempSync(join(tmpdir(), "octo-cleanup-"));
    try {
      const result = spawnSync(
        this.config.runtime,
        ["rm", "--force", "--volumes", "octo-check-" + id],
        {
          timeout: 10000,
          maxBuffer: 1024,
          env: { PATH: "/usr/bin:/bin", HOME: root, DOCKER_CONFIG: root }
        }
      );
      let removed = result.status === 0;
      if (!removed) {
        const remaining = spawnSync(
          this.config.runtime,
          [
            "container",
            "ls",
            "--all",
            "--filter",
            "name=^/octo-check-" + id + "$",
            "--format",
            "{{.ID}}"
          ],
          {
            timeout: 10000,
            maxBuffer: 1024,
            env: { PATH: "/usr/bin:/bin", HOME: root, DOCKER_CONFIG: root }
          }
        );
        removed =
          remaining.status === 0 && remaining.stdout.toString().trim() === "";
      }
      if (removed)
        rmSync(join(tmpdir(), "octo-check-" + id), {
          recursive: true,
          force: true
        });
      return removed;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  async run(
    base: CheckResult,
    files: { path: string; bytes: Uint8Array }[],
    signal: AbortSignal
  ): Promise<CheckResult> {
    const result = {
      ...base,
      startedAt: Date.now(),
      status: "unavailable" as CheckStatus,
      passed: false
    };
    const finish = () => {
      result.endedAt = Date.now();
      return result;
    };
    const c = this.config;
    if (!validConfig(c) || !Object.hasOwn(c.commands, base.kind))
      return finish();
    result.isolation = {
      network: "none",
      readOnly: true,
      uid: 65534,
      memoryBytes: 134217728,
      cpus: 0.5,
      pids: 64,
      timeoutMs: c.timeoutMs,
      outputBytes: c.outputBytes
    };
    result.image = c.image;
    result.executor = "docker-cli-v1";
    result.command = [...c.commands[base.kind]!];
    if (!/^[a-f0-9-]{36}$/.test(base.id)) return finish();
    const name = "octo-check-" + base.id;
    const root = join(tmpdir(), name);
    // Exclusive directory creation prevents a duplicate attempt from sharing a snapshot.
    mkdirSync(root, { mode: 0o700 });
    const snapshot = join(root, "snapshot");
    mkdirSync(snapshot, { mode: 0o755 });
    // A clean CLI environment prevents Docker config credentials/context/plugin inheritance.
    const env = { PATH: "/usr/bin:/bin", HOME: root, DOCKER_CONFIG: root };
    const call = (
      args: string[],
      timeout = 10000,
      abort?: AbortSignal,
      outputLimit = 4096
    ) =>
      new Promise<{
        code: number | null;
        output: string;
        timedOut: boolean;
        truncated: boolean;
      }>(resolve => {
        let output = Buffer.alloc(0),
          truncated = false,
          timedOut = false;
        const child = spawn(c.runtime, args, {
          env,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const collect = (chunk: Buffer) => {
          const room = Math.max(0, outputLimit - output.length);
          if (chunk.length > room) truncated = true;
          output = Buffer.concat([output, chunk.subarray(0, room)]);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const stop = () => {
          child.kill("SIGKILL");
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeout);
        abort?.addEventListener("abort", stop, { once: true });
        if (abort?.aborted) stop();
        const done = (code: number | null) => {
          clearTimeout(timer);
          abort?.removeEventListener("abort", stop);
          resolve({ code, output: output.toString(), timedOut, truncated });
        };
        child.on("error", () => done(null));
        child.on("close", done);
      });
    let attemptedCreate = false;
    try {
      let total = 0;
      if (files.length > 1000) return finish();
      for (const file of files) {
        total += file.bytes.length;
        if (total > 20 * 1024 * 1024) return finish();
        const path = join(snapshot, safePath(file.path));
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        writeFileSync(path, file.bytes, { mode: 0o644, flag: "wx" });
      }
      const inspect = await call([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        c.image
      ]);
      if (inspect.code !== 0 || inspect.output.trim() !== c.image)
        return finish();
      const volumes = await call([
        "image",
        "inspect",
        "--format",
        "{{json .Config.Volumes}}",
        c.image
      ]);
      if (volumes.code !== 0 || !["null", "{}"].includes(volumes.output.trim()))
        return finish();
      if (signal.aborted) {
        result.status = "cancelled";
        return finish();
      }
      const command = result.command;
      attemptedCreate = true;
      const created = await call([
        "create",
        "--pull=never",
        "--name",
        name,
        "--network=none",
        "--no-healthcheck",
        "--shm-size=16m",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--user=65534:65534",
        "--pids-limit=64",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=0.5",
        "--ulimit=nofile=128:128",
        "--ulimit=core=0:0",
        "--log-driver=none",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--workdir=/workspace",
        "--mount",
        `type=bind,src=${snapshot},dst=/workspace,readonly`,
        "--entrypoint",
        command[0]!,
        c.image,
        ...command.slice(1)
      ]);
      if (created.code !== 0) return finish();
      const run = await call(
        ["start", "--attach", name],
        c.timeoutMs,
        signal,
        c.outputBytes
      );
      result.log = safeLog(run.output).slice(0, c.outputBytes);
      result.truncated = run.truncated;
      if (signal.aborted) result.status = "cancelled";
      else if (run.timedOut) result.status = "timed_out";
      else {
        const state = await call([
          "inspect",
          "--format",
          "{{json .State}}",
          name
        ]);
        if (state.code === 0) {
          const parsed = JSON.parse(state.output);
          if (
            parsed.Status === "exited" &&
            Number.isInteger(parsed.ExitCode) &&
            parsed.ExitCode >= 0 &&
            parsed.ExitCode <= 255
          ) {
            result.exitCode = parsed.ExitCode;
            result.status =
              parsed.ExitCode === 0 && !parsed.OOMKilled && !parsed.Error
                ? "succeeded"
                : "failed";
          }
        }
      }
    } catch {
      result.status = "unavailable";
    } finally {
      const cleanup = await call(["rm", "--force", "--volumes", name]);
      result.cleanupPending = attemptedCreate && cleanup.code !== 0;
      if (result.cleanupPending && result.status === "succeeded")
        result.status = "unavailable";
      if (!result.cleanupPending)
        rmSync(root, { recursive: true, force: true });
    }
    result.passed = result.status === "succeeded";
    return finish();
  }
}
