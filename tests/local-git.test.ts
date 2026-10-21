import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realpathSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { Files } from "../packages/database/src/files.js";
import { checksum } from "../packages/delivery/src/github.js";
import { LocalGitProvider } from "../packages/delivery/src/local-git.js";

test("real local Git: bytes, refs, diff, recovery, isolation and hostile inputs", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "octo-git-")));
  const oldRoot = process.env.WORKSPACE_GIT_ROOT;
  process.env.WORKSPACE_GIT_ROOT = dir;
  const f = setup(join(dir, "db.sqlite"));
  f.activate();
  const id = f.current().id;
  const service = new Workspaces(f.db, f.auth);
  let seq = 0;
  const command = (
    action: string,
    extra: Record<string, unknown> = {},
    token = f.seller
  ) =>
    service.command(token, id, {
      action,
      version: 1,
      requestKey: `local-${++seq}`,
      ...extra
    });
  try {
    assert.equal(service.read(f.seller, id).provider, "local-uninitialized");
    assert.throws(() => command("initialize_repository"), /无权访问/);
    for (const permission of [
      "branch",
      "commit",
      "artifact",
      "pull_request",
      "check"
    ])
      command(
        "authorize",
        { actorId: "seller", permission, ttlMs: 900000, confirmed: true },
        f.buyer
      );
    const init = command("initialize_repository", {
      requestKey: "initialize-once"
    });
    assert.deepEqual(
      command("initialize_repository", { requestKey: "initialize-once" }),
      init
    );
    command("create_workspace_branch", { branch: "delivery" });
    for (const branch of [
      "--help",
      "../escape",
      "main.lock",
      "a//b",
      "constructor",
      "x@{0}"
    ])
      assert.throws(
        () => command("create_workspace_branch", { branch }),
        /INVALID_BRANCH/
      );
    const files = new Files(f.db, f.auth, {
      name: "explicit-test-only",
      simulated: false,
      scan: () => "clean"
    });
    const bytes = Buffer.from("export const value = '代码';\r\n");
    const file = files.upload(
      f.seller,
      {
        kind: "artifact",
        resourceId: id,
        version: 1,
        revision: 0,
        milestoneId: String(f.current().milestones[0]!.id),
        sha: "",
        name: "code.ts",
        mime: "text/plain",
        requestKey: "code-upload"
      },
      bytes
    );
    const input = {
      branch: "delivery",
      fileId: file.id,
      targetPath: "src/code.ts",
      summary: "导入代码",
      requestKey: "commit-once"
    };
    assert.throws(() => command("commit", input), /FILE_SCAN_BLOCKED/);
    await files.scan(String(file.id));
    for (const targetPath of [
      "../outside",
      "/tmp/outside",
      ".git/config",
      "src/.gitattributes",
      "--option"
    ])
      assert.throws(
        () =>
          command("commit", {
            ...input,
            targetPath,
            requestKey: `bad-${++seq}`
          }),
        /INVALID_PATH/
      );
    assert.throws(() => command("commit", input, f.second), /无权访问/);
    // Force a failure after real Git has committed but before DB publication.
    f.db.exec(
      "CREATE TRIGGER fail_git_publication BEFORE UPDATE ON delivery_workspaces BEGIN SELECT RAISE(ABORT, 'interrupted'); END"
    );
    assert.throws(() => command("commit", input), /interrupted/);
    assert.equal(service.read(f.seller, id).commits.length, 0);
    f.db.exec("DROP TRIGGER fail_git_publication");
    const saved = command("commit", input);
    assert.deepEqual(command("commit", input), saved);
    assert.throws(
      () => command("commit", { ...input, summary: "changed" }),
      /REQUEST_KEY_REUSED/
    );
    const reopened = new Workspaces(f.db, f.auth).read(f.seller, id);
    const commit = reopened.commits[0]!;
    assert.match(commit.sha, /^[a-f0-9]{40}$/);
    const repo = join(dir, checksum(id), reopened.localGit!.generation);
    assert.equal(
      execFileSync("/usr/bin/git", ["-C", repo, "rev-parse", "delivery"])
        .toString()
        .trim(),
      commit.sha
    );
    assert.deepEqual(readFileSync(join(repo, "src/code.ts")), bytes);
    assert.deepEqual(
      execFileSync("/usr/bin/git", [
        "-C",
        repo,
        "show",
        `${commit.sha}:src/code.ts`
      ]),
      bytes
    );
    assert.match(JSON.stringify(commit), /diff --git/);
    assert.throws(
      () => command("create_pull_request", { sha: commit.sha }),
      /LOCAL_GIT_OPERATION_UNAVAILABLE/
    );
    assert.throws(
      () => command("run_check", { sha: commit.sha, kind: "test" }),
      /LOCAL_GIT_OPERATION_UNAVAILABLE/
    );
    assert.throws(
      () => new LocalGitProvider(dir).verify("other-contract", reopened),
      /GIT_REPOSITORY_MISSING/
    );
    const otherTask = f.publish();
    const otherBid = f.submit(f.seller, otherTask);
    const otherId = f.contracts.select(f.buyer, otherBid.id, true).id;
    for (const [token, action, extra] of [
      [f.buyer, "transition", { to: "pending_confirmation" }],
      [f.buyer, "confirm", {}],
      [f.seller, "confirm", {}]
    ] as const) {
      const current = f.contracts.read(token, otherId);
      f.contracts.command(token, otherId, {
        action,
        ...extra,
        version: current.version,
        revision: current.revision,
        requestKey: `other-${++seq}`,
        reason: { code: "scope", detail: "隔离测试合同" },
        confirmed: true
      });
    }
    const otherCommand = (
      action: string,
      extra: Record<string, unknown> = {},
      token = f.seller
    ) =>
      service.command(token, otherId, {
        action,
        version: 1,
        requestKey: `other-git-${++seq}`,
        ...extra
      });
    for (const permission of ["branch", "commit"])
      otherCommand(
        "authorize",
        { actorId: "seller", permission, ttlMs: 900000, confirmed: true },
        f.buyer
      );
    otherCommand("initialize_repository");
    assert.throws(
      () => otherCommand("commit", { ...input, branch: "main" }),
      /ARTIFACT_BINDING_MISMATCH/
    );
    assert.equal(service.read(f.seller, otherId).codeArtifacts.length, 0);
    assert.equal(service.read(f.seller, otherId).commits.length, 0);
    const marker = join(dir, "executed");
    writeFileSync(join(repo, ".git/hooks-marker"), "unused");
    // Hooks may exist on disk, but Git never invokes them.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git/hooks/pre-commit"),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      { mode: 0o700 }
    );
    const previousDiff = process.env.GIT_EXTERNAL_DIFF;
    const previousConfig = process.env.GIT_CONFIG_GLOBAL;
    const poisonedConfig = join(dir, "host-config");
    writeFileSync(
      poisonedConfig,
      `[include]\npath = /must-not-read-host-config\n[core]\nhooksPath = ${join(
        repo,
        ".git/hooks"
      )}\n`
    );
    process.env.GIT_EXTERNAL_DIFF = marker;
    process.env.GIT_CONFIG_GLOBAL = poisonedConfig;
    try {
      command("commit", { ...input, requestKey: "hook-test" });
    } finally {
      if (previousDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = previousDiff;
      if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousConfig;
    }
    assert.equal(existsSync(marker), false);
    // Independent processes reopen SQLite + real repositories and race the same request.
    const worker = () =>
      new Promise<string>((resolve, reject) => {
        const script = `
        import { DatabaseSync } from 'node:sqlite';
        import { Workspaces } from './dist/packages/database/src/workspaces.js';
        import { Authorization } from './dist/packages/auth/src/index.js';
        import { SqliteIdentityStore } from './dist/packages/database/src/identity.js';
        let input = ''; for await (const chunk of process.stdin) input += chunk;
        const p = JSON.parse(input);
        const db = new DatabaseSync(p.db); db.exec('PRAGMA busy_timeout=10000');
        const auth = new Authorization(new SqliteIdentityStore(db), () => 1000);
        const service = new Workspaces(db, auth);
        const before = service.read(p.token, p.id);
        if (before.provider !== 'real-local-git') throw new Error('wrong mode');
        const result = service.command(p.token, p.id, p.command);
        process.stdout.write(JSON.stringify(result)); db.close();
      `;
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        let output = "";
        let errors = "";
        child.stdout.on("data", b => {
          output += b;
        });
        child.stderr.on("data", b => {
          errors += b;
        });
        child.on("error", reject);
        child.on("close", code =>
          code === 0 ? resolve(output) : reject(new Error(errors))
        );
        child.stdin.end(
          JSON.stringify({
            db: join(dir, "db.sqlite"),
            token: f.seller,
            id,
            command: {
              action: "commit",
              version: 1,
              ...input,
              requestKey: "concurrent-restart"
            }
          })
        );
      });
    const raced = await Promise.all([worker(), worker()]);
    assert.equal(raced[0], raced[1]);
    assert.equal(service.read(f.seller, id).commits.length, 3);
    const latest = service.read(f.seller, id);
    const latestRepo = join(dir, checksum(id), latest.localGit!.generation);
    const config = readFileSync(join(latestRepo, ".git/config"));
    writeFileSync(
      join(latestRepo, ".git/config"),
      Buffer.concat([
        config,
        Buffer.from(
          `\n[include]\npath = ${marker}\n[credential]\nhelper = !touch ${marker}\n`
        )
      ])
    );
    assert.throws(() => service.read(f.seller, id), /GIT_UNSAFE_CONFIG/);
    assert.equal(existsSync(marker), false);
    writeFileSync(join(latestRepo, ".git/config"), config);
    symlinkSync(dir, join(latestRepo, "escape"));
    assert.throws(() => service.read(f.seller, id), /GIT_UNSAFE_PATH/);
    rmSync(join(latestRepo, "escape"));
    assert.throws(
      () =>
        new LocalGitProvider(dir, join(dir, "missing-git")).verify(id, latest),
      /GIT_UNAVAILABLE/
    );
    f.command(f.buyer, "transition", {
      to: "paused",
      revision: f.contracts.read(f.buyer, id).revision
    });
    assert.throws(
      () => command("commit", { ...input, requestKey: "paused" }),
      /CONTRACT_NOT_ACTIVE/
    );
    rmSync(join(latestRepo, ".git/config"));
    assert.throws(() => service.read(f.seller, id), /GIT_REPOSITORY_CORRUPT/);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.WORKSPACE_GIT_ROOT;
    else process.env.WORKSPACE_GIT_ROOT = oldRoot;
  }
});

test("workspace controls initialize, select scanned code, branch, commit and display real diff", async () => {
  const { mountWorkspaces, renderWorkspaces } = await import(
    "../apps/web/src/workspaces.js"
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "octo-git-ui-")));
  const previousRoot = process.env.WORKSPACE_GIT_ROOT;
  process.env.WORKSPACE_GIT_ROOT = dir;
  const f = setup();
  f.activate();
  const id = f.current().id;
  const service = new Workspaces(f.db, f.auth);
  const originalFetch = globalThis.fetch;
  class Element extends EventTarget {
    value = "";
    textContent = "";
    hidden = false;
    disabled = false;
    children: Element[] = [];
    append(child: Element) {
      this.children.push(child);
      if (this.children.length === 1) this.value = child.value;
    }
    replaceChildren() {
      this.children = [];
      this.value = "";
    }
    click() {
      this.dispatchEvent(new Event("click"));
    }
  }
  const elements = new Map(
    [...renderWorkspaces().matchAll(/id="([^"]+)"/g)].map(m => [
      m[1]!,
      new Element()
    ])
  );
  // Upload controls have their own byte-stream tests; exercise repository controls here.
  elements.delete("private-files");
  const root = ({
    getElementById: (name: string) => elements.get(name),
    createElement: () => new Element()
  } as unknown) as Document;
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    for (const permission of ["branch", "commit", "artifact"])
      service.command(f.buyer, id, {
        action: "authorize",
        version: 1,
        requestKey: `ui-${permission}`,
        actorId: "seller",
        permission,
        ttlMs: 900000,
        confirmed: true
      });
    const files = new Files(f.db, f.auth, {
      name: "explicit-test-only",
      simulated: false,
      scan: () => "clean"
    });
    const file = files.upload(
      f.seller,
      {
        kind: "artifact",
        resourceId: id,
        version: 1,
        revision: 0,
        milestoneId: String(f.current().milestones[0]!.id),
        sha: "",
        name: "ready.ts",
        mime: "text/plain",
        requestKey: "ui-upload"
      },
      Buffer.from("export const ready = true;\n")
    );
    await files.scan(String(file.id));
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      let data: unknown;
      if (path === "/api/auth/me") data = { csrf: "test-session" };
      else if (path === "/api/contracts")
        data = [f.contracts.read(f.seller, id)];
      else if (init?.method === "POST")
        data = service.command(f.seller, id, JSON.parse(String(init.body)));
      else data = service.read(f.seller, id);
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    }) as typeof fetch;
    mountWorkspaces(root);
    await flush();
    assert.equal(elements.get("contract")!.value, id);
    assert.equal(
      elements.get("file-milestone")!.value,
      f.current().milestones[0]!.id
    );
    assert.equal(elements.get("code-artifact")!.value, file.id);
    elements.get("git-init")!.click();
    await flush();
    assert.match(elements.get("git-mode")!.textContent, /真实本地 Git/);
    elements.get("new-branch")!.value = "delivery";
    elements
      .get("branch-form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    elements.get("git-branch")!.value = "delivery";
    elements.get("target-path")!.value = "src/ready.ts";
    elements.get("commit-summary")!.value = "导入已扫描代码";
    elements
      .get("commit-form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.match(
      elements.get("git-diff")!.textContent,
      /\+export const ready = true;/
    );
    assert.equal(service.read(f.seller, id).commits.length, 1);
    elements.get("contract")!.dispatchEvent(new Event("input"));
    assert.equal(elements.get("git-diff")!.textContent, "");
    assert.equal(elements.get("git-operations")!.hidden, true);
  } finally {
    globalThis.fetch = originalFetch;
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.WORKSPACE_GIT_ROOT;
    else process.env.WORKSPACE_GIT_ROOT = previousRoot;
  }
});
