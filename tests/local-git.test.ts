import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { Files } from "../packages/database/src/files.js";
import { LocalGitProvider } from "../packages/delivery/src/local-git.js";
import { Authorization, ForbiddenError } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octo-git-")));
  const previousRoot = process.env.GIT_REPOSITORY_ROOT;
  process.env.GIT_REPOSITORY_ROOT = root;
  const dbPath = join(root, "state.sqlite");
  const f = setup(dbPath);
  f.activate();
  const id = f.current().id;
  const service = new Workspaces(
    f.db,
    f.auth,
    Date.now,
    new LocalGitProvider(root)
  );
  let n = 0;
  const command = (
    action: string,
    extra: Record<string, unknown> = {},
    token = f.seller
  ) =>
    service.command(token, id, {
      action,
      version: 1,
      requestKey: `git-${++n}`,
      ...extra
    });
  for (const permission of [
    "branch",
    "commit",
    "artifact",
    "check",
    "pull_request"
  ])
    command(
      "authorize",
      { actorId: "seller", permission, ttlMs: 900000, confirmed: true },
      f.buyer
    );
  const files = new Files(f.db, f.auth, {
    name: "test-only-byte-scanner",
    simulated: false,
    scan: () => "clean"
  });
  const bytes = Buffer.from("// source\r\nexport const value = '你好';\n\n");
  const input = {
    kind: "artifact" as const,
    resourceId: id,
    version: 1,
    revision: 0,
    milestoneId: String(f.current().milestones[0]!.id),
    sha: "",
    name: "source.ts",
    mime: "text/plain",
    requestKey: "source-file"
  };
  const file = files.upload(f.seller, input, bytes);
  const args = {
    branch: "delivery",
    path: "src/source.ts",
    fileId: file.id,
    summary: "Import scanned source",
    requestKey: "import-once"
  };
  const dir = () => {
    const state = service.read(f.seller, id);
    return join(
      root,
      createHash("sha256")
        .update(id)
        .digest("hex"),
      state.local!.generation
    );
  };
  const close = () => {
    if (previousRoot === undefined) delete process.env.GIT_REPOSITORY_ROOT;
    else process.env.GIT_REPOSITORY_ROOT = previousRoot;
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    ...f,
    root,
    dbPath,
    id,
    service,
    command,
    files,
    file,
    bytes,
    args,
    dir,
    close
  };
}

test("real file -> branch -> Git commit -> diff -> fresh process verifies exact bytes and SHA", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.read(f.seller, f.id).provider, "uninitialized");
    f.command("initialize_repository");
    f.command("create_workspace_branch", { branch: "delivery" });
    assert.throws(
      () => f.command("import_artifact", f.args),
      /FILE_SCAN_BLOCKED/
    );
    await f.files.scan(String(f.file.id));
    const result = f.command("import_artifact", f.args);
    assert.deepEqual(f.command("import_artifact", f.args), result);
    const state = f.service.read(f.seller, f.id);
    const commit = state.commits[0]!;
    assert.match(commit.sha, /^[a-f0-9]{40}$/);
    assert.equal(commit.version, 1);
    assert.equal(commit.source!.checksum, f.file.checksum);
    assert.match(state.diffs[0]!.patch, /export const value/);
    assert.deepEqual(state.pullRequests, []);
    const external = spawnSync("/usr/bin/git", [
      "--git-dir",
      f.dir(),
      "show",
      `${commit.sha}:src/source.ts`
    ]);
    assert.equal(external.status, 0);
    assert.deepEqual(external.stdout, f.bytes);
    const resolved = spawnSync("/usr/bin/git", [
      "--git-dir",
      f.dir(),
      "rev-parse",
      "refs/heads/delivery"
    ]);
    assert.equal(resolved.status, 0);
    assert.equal(resolved.stdout.toString().trim(), commit.sha);
    f.db
      .prepare("UPDATE private_files SET simulated=1 WHERE id=?")
      .run(String(f.file.id));
    assert.throws(
      () => f.command("import_artifact", f.args),
      /FILE_SCAN_BLOCKED/
    );
    f.db
      .prepare("UPDATE private_files SET simulated=0 WHERE id=?")
      .run(String(f.file.id));
    const script = `import { DatabaseSync } from 'node:sqlite';
      import { Workspaces } from './dist/packages/database/src/workspaces.js';
      import { Authorization } from './dist/packages/auth/src/index.js';
      import { SqliteIdentityStore } from './dist/packages/database/src/identity.js';
      const db = new DatabaseSync(process.argv[1]);
      const auth = new Authorization(new SqliteIdentityStore(db), () => 1000);
      const service = new Workspaces(db, auth, () => 1000);
      const state = service.read(auth.issueUserSession('seller'), process.argv[2]);
      process.stdout.write(JSON.stringify(state.commits)); db.close();`;
    const reopened = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, f.dbPath, f.id],
      { env: { ...process.env, GIT_REPOSITORY_ROOT: f.root } }
    );
    assert.equal(reopened.status, 0, reopened.stderr.toString());
    assert.deepEqual(JSON.parse(reopened.stdout.toString()), state.commits);
    assert.throws(
      () => f.command("create_pull_request", { sha: commit.sha }),
      /REMOTE_PR_NOT_AVAILABLE/
    );
    assert.throws(
      () => f.command("run_check", { sha: commit.sha, kind: "test" }),
      /REAL_CHECK_NOT_AVAILABLE/
    );
  } finally {
    f.close();
  }
});

test("failed database publication leaves immutable old generation; retry and concurrent connections publish once", async () => {
  const f = await fixture();
  try {
    f.command("initialize_repository");
    f.command("create_workspace_branch", { branch: "delivery" });
    await f.files.scan(String(f.file.id));
    const before = f.service.read(f.seller, f.id);
    f.db.exec(
      "CREATE TRIGGER fail_publish BEFORE INSERT ON delivery_requests WHEN NEW.request_key='import-once' BEGIN SELECT RAISE(ABORT,'publication failed'); END"
    );
    assert.throws(
      () => f.command("import_artifact", f.args),
      /publication failed/
    );
    assert.deepEqual(f.service.read(f.seller, f.id), before);
    f.db.exec("DROP TRIGGER fail_publish");
    // Orphan generation exists but is never selected by directory discovery.
    const scope = join(
      f.root,
      createHash("sha256")
        .update(f.id)
        .digest("hex")
    );
    assert.equal(readdirSync(scope).length, 3);
    const otherDb = new DatabaseSync(f.dbPath);
    try {
      const auth = new Authorization(
        new SqliteIdentityStore(otherDb),
        () => 1000
      );
      const service = new Workspaces(
        otherDb,
        auth,
        () => 1000,
        new LocalGitProvider(f.root)
      );
      const token = auth.issueUserSession("seller");
      const results = await Promise.all([
        Promise.resolve().then(() => f.command("import_artifact", f.args)),
        Promise.resolve().then(() =>
          service.command(token, f.id, {
            action: "import_artifact",
            version: 1,
            ...f.args
          })
        )
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(service.read(token, f.id).commits.length, 1);
      assert.throws(
        () => f.command("import_artifact", { ...f.args, path: "other.ts" }),
        /REQUEST_KEY_REUSED/
      );
    } finally {
      otherDb.close();
    }
  } finally {
    f.close();
  }
});

test("authorization, freeze, scan, source binding and malicious inputs preserve repository state", async () => {
  const f = await fixture();
  try {
    f.command("initialize_repository");
    f.command("create_workspace_branch", { branch: "delivery" });
    await f.files.scan(String(f.file.id));
    const before = f.service.read(f.seller, f.id);
    for (const field of ["remote", "command", "repositoryPath"])
      assert.throws(
        () => f.command("import_artifact", { ...f.args, [field]: "untrusted" }),
        /INVALID_GIT_INPUT/
      );
    assert.throws(
      () => f.command("import_artifact", f.args, f.second),
      ForbiddenError
    );
    for (const path of [
      "../outside",
      "/tmp/out",
      ".git/config",
      "a/.git/config",
      "a/../../x",
      "a\\b",
      "-x",
      "git~1/config"
    ])
      assert.throws(
        () => f.command("import_artifact", { ...f.args, path }),
        /INVALID_PATH/
      );
    for (const branch of [
      "--help",
      "refs/heads/x",
      "x..y",
      "HEAD",
      "x@{1}",
      "x;touch"
    ])
      assert.throws(
        () => f.command("create_workspace_branch", { branch }),
        /INVALID_BRANCH/
      );
    f.db.prepare("UPDATE contracts SET version=2 WHERE id=?").run(f.id);
    assert.throws(
      () => f.command("import_artifact", { ...f.args, version: 2 }),
      /ARTIFACT_BINDING_MISMATCH/
    );
    f.db.prepare("UPDATE contracts SET version=1 WHERE id=?").run(f.id);
    f.db
      .prepare("UPDATE private_files SET simulated=1 WHERE id=?")
      .run(String(f.file.id));
    assert.throws(
      () => f.command("import_artifact", f.args),
      /FILE_SCAN_BLOCKED/
    );
    f.db
      .prepare("UPDATE private_files SET simulated=0 WHERE id=?")
      .run(String(f.file.id));
    f.db.prepare("UPDATE contracts SET status='disputed' WHERE id=?").run(f.id);
    assert.throws(
      () => f.command("import_artifact", f.args),
      /CONTRACT_NOT_ACTIVE/
    );
    f.db.prepare("UPDATE contracts SET status='active' WHERE id=?").run(f.id);
    assert.deepEqual(f.service.read(f.seller, f.id), before);
    const dir = f.dir();
    const saved = readFileSync(join(dir, "config"));
    writeFileSync(
      join(dir, "config"),
      Buffer.concat([
        saved,
        Buffer.from("\n[credential]\n helper = malicious\n")
      ])
    );
    assert.throws(
      () => f.service.read(f.seller, f.id),
      /GIT_REPOSITORY_CORRUPT/
    );
    writeFileSync(join(dir, "config"), saved);
    symlinkSync(f.root, join(dir, "escape"));
    assert.throws(() => f.service.read(f.seller, f.id), /GIT_UNSAFE_STORAGE/);
  } finally {
    f.close();
  }
});

test("missing deployment configuration/Git and hostile host configuration never fake success", async () => {
  const f = await fixture();
  try {
    const run = (provider: LocalGitProvider) =>
      new Workspaces(f.db, f.auth, () => 1000, provider).command(
        f.seller,
        f.id,
        { action: "initialize_repository", version: 1, requestKey: "init" }
      );
    assert.throws(
      () => run(new LocalGitProvider("")),
      /GIT_CONFIGURATION_REQUIRED/
    );
    assert.throws(
      () => run(new LocalGitProvider(f.root, "/nonexistent/git")),
      /GIT_UNAVAILABLE/
    );
    assert.throws(
      () => run(new LocalGitProvider(f.root, "/usr/bin/false")),
      /GIT_OPERATION_FAILED/
    );
    assert.throws(
      () => run(new LocalGitProvider(join(f.root, "missing"))),
      /GIT_CONFIGURATION_REQUIRED/
    );
    const marker = join(f.root, "executed");
    writeFileSync(
      join(f.root, "pre-commit"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o700 }
    );
    const hostile = join(f.root, "host-config");
    writeFileSync(
      hostile,
      `[core]\n hooksPath = ${f.root}\n[credential]\n helper = !touch ${marker}\n[diff]\n external = touch ${marker}\n`
    );
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostile;
    try {
      f.command("initialize_repository");
      f.command("create_workspace_branch", { branch: "delivery" });
      await f.files.scan(String(f.file.id));
      f.command("import_artifact", f.args);
      assert.equal(f.service.read(f.seller, f.id).commits.length, 1);
      assert.equal(existsSync(marker), false);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  } finally {
    f.close();
  }
});

test("process death before publication rolls back; competing processes replay a single committed operation", async () => {
  const f = await fixture();
  try {
    f.command("initialize_repository");
    f.command("create_workspace_branch", { branch: "delivery" });
    await f.files.scan(String(f.file.id));
    const before = f.service.read(f.seller, f.id);
    const script = `import { DatabaseSync } from 'node:sqlite';
      import { Workspaces } from './dist/packages/database/src/workspaces.js';
      import { LocalGitProvider } from './dist/packages/delivery/src/local-git.js';
      import { Authorization } from './dist/packages/auth/src/index.js';
      import { SqliteIdentityStore } from './dist/packages/database/src/identity.js';
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=15000');
      const auth = new Authorization(new SqliteIdentityStore(db), () => 1000);
      class Interrupted extends LocalGitProvider {
        publishReady(state,id) { super.publishReady(state,id); process.kill(process.pid, 'SIGKILL'); }
      }
      const provider = process.argv[4] === 'crash' ? new Interrupted() : new LocalGitProvider();
      const service = new Workspaces(db, auth, () => 1000, provider);
      const result = service.command(auth.issueUserSession('seller'), process.argv[2], JSON.parse(process.argv[3]));
      process.stdout.write(JSON.stringify(result)); db.close();`;
    const args = [
      "--input-type=module",
      "-e",
      script,
      f.dbPath,
      f.id,
      JSON.stringify({ action: "import_artifact", version: 1, ...f.args })
    ];
    const crashed = spawnSync(process.execPath, [...args, "crash"], {
      env: process.env
    });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr.toString());
    assert.deepEqual(f.service.read(f.seller, f.id), before);
    const { spawn } = await import("node:child_process");
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [...args, "retry"], {
          env: process.env
        });
        let output = "",
          errors = "";
        child.stdout.on("data", data => (output += data));
        child.stderr.on("data", data => (errors += data));
        child.on("error", reject);
        child.on("close", code =>
          code === 0 ? resolve(output) : reject(new Error(errors))
        );
      });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(JSON.parse(results[0]!), JSON.parse(results[1]!));
    assert.equal(f.service.read(f.seller, f.id).commits.length, 1);
  } finally {
    f.close();
  }
});

test("web selects contract and scanned source, initializes, branches, imports and displays real diff without IDs", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  try {
    await f.files.scan(String(f.file.id));
    const { renderWorkspaces, mountWorkspaces } = await import(
      "../apps/web/src/workspaces.js"
    );
    class Element extends EventTarget {
      value = "";
      textContent = "";
      hidden = false;
      checked = false;
      children: Element[] = [];
      append(child: Element) {
        this.children.push(child);
        if (!this.value) this.value = child.value;
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
    const el = (id: string) => elements.get(id)!;
    const root = (Object.assign(new EventTarget(), {
      getElementById: (id: string) => elements.get(id),
      createElement: () => new Element()
    }) as unknown) as Document;
    const seen: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      let data: unknown;
      if (url === "/api/auth/me") data = { csrf: "test-csrf" };
      else if (url === "/api/contracts")
        data = [
          {
            id: f.id,
            status: "active",
            versions: [{ terms: { scope: "真实代码合同" } }]
          }
        ];
      else if (url.startsWith("/api/files?"))
        data = f.files.list(f.seller, "artifact", f.id);
      else if (url.endsWith("/commands")) {
        const body = JSON.parse(String(options!.body));
        seen.push(body);
        data = f.service.command(f.seller, f.id, body);
      } else data = f.service.read(f.seller, f.id);
      return { ok: true, json: async () => ({ ok: true, data }) } as Response;
    }) as typeof fetch;
    const settle = async () => {
      for (let i = 0; i < 10; i++)
        await new Promise<void>(r => setImmediate(r));
    };
    mountWorkspaces(root);
    await settle();
    assert.match(el("status").textContent, /未初始化/);
    assert.equal(el("contract").value, f.id);
    el("git-init").click();
    await settle();
    assert.match(el("status").textContent, /真实本地 Git/);
    el("git-branch").value = "web-delivery";
    el("branch-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    assert.equal(el("source-file").value, f.file.id);
    assert.equal(el("target-branch").value, "web-delivery");
    el("target-path").value = "src/web.ts";
    el("git-summary").value = "Web import";
    el("import-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    assert.match(el("diffs").textContent, /export const value/);
    assert.equal(f.service.read(f.seller, f.id).commits.length, 1);
    assert.equal(f.service.read(f.seller, f.id).pullRequests.length, 0);
    assert.deepEqual(
      seen.map(b => b.action),
      ["initialize_repository", "create_workspace_branch", "import_artifact"]
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test("even parties to two contracts cannot import across their isolated repositories", async () => {
  const f = await fixture();
  try {
    f.command("initialize_repository");
    await f.files.scan(String(f.file.id));
    const first = f.service.read(f.seller, f.id);
    const task = f.publish();
    const bid = f.submit(f.seller, task);
    let contract = f.contracts.select(f.buyer, bid.id, true);
    let contractSequence = 0;
    for (const [token, action, extra] of [
      [f.buyer, "transition", { to: "pending_confirmation" }],
      [f.buyer, "confirm", {}],
      [f.seller, "confirm", {}]
    ] as const)
      contract = f.contracts.command(token, contract.id, {
        action,
        ...extra,
        confirmed: true,
        version: contract.version,
        revision: contract.revision,
        reason: { code: "scope", detail: "测试合同确认" },
        requestKey: `contract-${++contractSequence}`
      });
    let n = 0;
    const command = (
      action: string,
      extra: Record<string, unknown> = {},
      token = f.seller
    ) =>
      f.service.command(token, contract.id, {
        action,
        version: 1,
        requestKey: `second-${++n}`,
        ...extra
      });
    for (const permission of ["branch", "commit"])
      command(
        "authorize",
        { actorId: "seller", permission, ttlMs: 900000, confirmed: true },
        f.buyer
      );
    command("initialize_repository");
    command("create_workspace_branch", { branch: "delivery" });
    assert.throws(
      () => command("import_artifact", f.args),
      /ARTIFACT_BINDING_MISMATCH/
    );
    assert.deepEqual(f.service.read(f.seller, f.id), first);
    const second = f.service.read(f.seller, contract.id);
    assert.equal(second.commits.length, 0);
    assert.notEqual(first.local!.contractId, second.local!.contractId);
    // Forged database pointer cannot redirect a contract into another contract's generation.
    const saved = f.db
      .prepare("SELECT state FROM delivery_workspaces WHERE contract_id=?")
      .get(contract.id)!.state;
    f.db
      .prepare("UPDATE delivery_workspaces SET state=? WHERE contract_id=?")
      .run(JSON.stringify({ ...second, local: first.local }), contract.id);
    assert.throws(
      () => f.service.read(f.seller, contract.id),
      /GIT_REPOSITORY_CORRUPT/
    );
    f.db
      .prepare("UPDATE delivery_workspaces SET state=? WHERE contract_id=?")
      .run(String(saved), contract.id);
  } finally {
    f.close();
  }
});
