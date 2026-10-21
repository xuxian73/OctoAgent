import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ContainerExecutor,
  CheckResult,
  validConfig
} from "../packages/delivery/src/executor.js";

test("executor rejects configuration expansion and missing runtime without fallback", async () => {
  const config = {
    runtime: "/nonexistent/octo-runtime",
    image: "sha256:" + "a".repeat(64),
    commands: { test: ["/fixture/test"] },
    timeoutMs: 100,
    outputBytes: 128
  };
  assert.equal(validConfig(config), true);
  for (const change of [
    { network: "host" },
    { mounts: ["/"] },
    { privileged: true },
    { runtime: "docker" },
    { image: "latest" },
    { timeoutMs: 300001 },
    { outputBytes: 65537 },
    { commands: { test: ["shell"], unsafe: ["/bin/sh"] } }
  ])
    assert.equal(validConfig({ ...config, ...change }), false);
  const base: CheckResult = {
    id: randomUUID(),
    sha: "a".repeat(40),
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
  const result = await new ContainerExecutor(config).run(
    base,
    [],
    new AbortController().signal
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, null);
});
