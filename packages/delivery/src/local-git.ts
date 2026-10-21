import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, resolve, parse } from "node:path";
import { ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
import {
  GitHubProvider,
  Permission,
  RepositoryState,
  safePath
} from "./github.js";

const config =
  "[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tlogallrefupdates = false\n";
const fail = (code: string): never => {
  throw new RequirementError(code, 409);
};
const sha = (value: string) =>
  /^[a-f0-9]{40}$/.test(value) ? value : fail("GIT_REPOSITORY_CORRUPT");
export function branchName(value: string) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ||
    ["HEAD", "__proto__", "constructor", "prototype"].includes(value)
  )
    fail("INVALID_BRANCH");
  return value;
}
/** Bare plumbing only: never checkout, run code, use filters, or contact remotes. */
export class LocalGitProvider implements GitHubProvider {
  constructor(
    private root = process.env.GIT_REPOSITORY_ROOT,
    private executable = "/usr/bin/git"
  ) {}
  authorize(permission: Permission, granted: readonly string[]) {
    if (!granted.includes(permission)) throw new ForbiddenError();
  }
  private rootPath() {
    if (!this.root || !isAbsolute(this.root))
      return fail("GIT_CONFIGURATION_REQUIRED");
    const root = resolve(this.root);
    let current = parse(root).root;
    for (const part of root
      .slice(current.length)
      .split("/")
      .filter(Boolean)) {
      current = join(current, part);
      if (!existsSync(current)) fail("GIT_CONFIGURATION_REQUIRED");
      if (
        !lstatSync(current).isDirectory() ||
        lstatSync(current).isSymbolicLink()
      )
        fail("GIT_UNSAFE_STORAGE");
    }
    return root;
  }
  private directory(id: string, generation: string) {
    if (!/^[a-f0-9-]{36}$/.test(generation))
      return fail("GIT_REPOSITORY_CORRUPT");
    const scope = createHash("sha256")
      .update(id)
      .digest("hex");
    return join(this.rootPath(), scope, generation);
  }
  private run(
    dir: string,
    args: string[],
    input?: Uint8Array | string
  ): Buffer {
    const result = spawnSync(
      this.executable,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "protocol.allow=never",
        "-c",
        "gc.auto=0",
        ...args
      ],
      {
        cwd: dir,
        input,
        timeout: 30000,
        maxBuffer: 24 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "OctoAgent",
          GIT_AUTHOR_EMAIL: "local@invalid",
          GIT_COMMITTER_NAME: "OctoAgent",
          GIT_COMMITTER_EMAIL: "local@invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          LC_ALL: "C"
        }
      }
    );
    if (
      result.error &&
      "code" in result.error &&
      result.error.code === "ENOENT"
    )
      fail("GIT_UNAVAILABLE");
    if (result.error || result.status !== 0) fail("GIT_OPERATION_FAILED");
    return result.stdout;
  }
  private inspectDirectory(dir: string) {
    const visit = (p: string) => {
      const stat = lstatSync(p);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        fail("GIT_UNSAFE_STORAGE");
      if (stat.isDirectory())
        for (const name of readdirSync(p)) visit(join(p, name));
    };
    visit(dir);
    if (
      readFileSync(join(dir, "config"), "utf8") !== config ||
      readdirSync(join(dir, "objects", "info")).length
    )
      fail("GIT_REPOSITORY_CORRUPT");
  }
  verify(state: RepositoryState, id: string) {
    if (!state.local) return;
    if (state.local.contractId !== id) fail("GIT_REPOSITORY_CORRUPT");
    try {
      const dir = this.directory(id, state.local.generation);
      // Check scope itself too, before traversing any generation.
      if (lstatSync(resolve(dir, "..")).isSymbolicLink())
        fail("GIT_UNSAFE_STORAGE");
      this.inspectDirectory(dir);
      this.run(dir, ["fsck", "--full", "--no-reflogs"]);
      for (const [branch, expected] of Object.entries(state.branches)) {
        if (
          this.run(dir, [
            "rev-parse",
            "--verify",
            `refs/heads/${branchName(branch)}`
          ])
            .toString()
            .trim() !== sha(expected)
        )
          fail("GIT_REPOSITORY_CORRUPT");
      }
      for (const commit of state.commits) {
        this.run(dir, ["cat-file", "-e", `${sha(commit.sha)}^{commit}`]);
        if (commit.source) {
          const bytes = this.run(dir, [
            "show",
            `${commit.sha}:${safePath(commit.source.path)}`
          ]);
          if (
            createHash("sha256")
              .update(bytes)
              .digest("hex") !== commit.source.checksum
          )
            fail("GIT_REPOSITORY_CORRUPT");
        }
      }
    } catch (error) {
      if (error instanceof RequirementError) throw error;
      fail("GIT_REPOSITORY_CORRUPT");
    }
  }
  private next(state: RepositoryState, id: string) {
    this.verify(state, id);
    const generation = randomUUID();
    const dir = this.directory(id, generation);
    mkdirSync(resolve(dir, ".."), { recursive: true, mode: 0o700 });
    if (lstatSync(resolve(dir, "..")).isSymbolicLink())
      fail("GIT_UNSAFE_STORAGE");
    if (state.local)
      cpSync(this.directory(id, state.local.generation), dir, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
    else {
      mkdirSync(dir, { mode: 0o700 });
      this.run(dir, [
        "init",
        "--bare",
        "--template=",
        "--initial-branch=main",
        "."
      ]);
      writeFileSync(join(dir, "config"), config);
    }
    state.local = { contractId: id, generation };
    return dir;
  }
  initialize(state: RepositoryState, id: string) {
    if (state.local) fail("GIT_ALREADY_INITIALIZED");
    if (state.commits.length || Object.keys(state.branches).length)
      fail("GIT_HISTORICAL_SIMULATION");
    const dir = this.next(state, id);
    const tree = this.run(dir, ["mktree"], "")
      .toString()
      .trim();
    const initial = sha(
      this.run(dir, ["commit-tree", tree], "Initialize local repository\n")
        .toString()
        .trim()
    );
    this.run(dir, ["update-ref", "refs/heads/main", initial]);
    state.branches.main = initial;
    return { provider: "local-git", sha: initial };
  }
  createBranch(state: RepositoryState, branch: string) {
    branchName(branch);
    if (!state.local) return fail("GIT_NOT_INITIALIZED");
    if (Object.hasOwn(state.branches, branch)) fail("BRANCH_EXISTS");
    const dir = this.next(state, state.local.contractId);
    const base = sha(state.branches.main!);
    this.run(dir, ["update-ref", `refs/heads/${branch}`, base]);
    state.branches[branch] = base;
    return { branch, sha: base };
  }
  importArtifact(
    state: RepositoryState,
    id: string,
    branch: string,
    path: string,
    bytes: Uint8Array,
    summary: string,
    version: number,
    fileId: string,
    checksum: string
  ) {
    branchName(branch);
    safePath(path);
    if (path.split("/").some(p => p.startsWith("-"))) fail("INVALID_PATH");
    if (
      path
        .split("/")
        .some(
          p => p.toLowerCase().startsWith(".git") || p.toLowerCase() === "git~1"
        )
    )
      fail("INVALID_PATH");
    if (!state.local) return fail("GIT_NOT_INITIALIZED");
    if (branch === "main" || !Object.hasOwn(state.branches, branch))
      fail("BRANCH_REQUIRED");
    const parent = sha(state.branches[branch]!);
    const dir = this.next(state, id);
    this.run(dir, ["read-tree", parent]);
    const blob = sha(
      this.run(dir, ["hash-object", "-w", "--stdin"], bytes)
        .toString()
        .trim()
    );
    this.run(dir, [
      "update-index",
      "--add",
      "--cacheinfo",
      "100644",
      blob,
      path
    ]);
    const tree = sha(
      this.run(dir, ["write-tree"])
        .toString()
        .trim()
    );
    const commitSha = sha(
      this.run(dir, ["commit-tree", tree, "-p", parent], summary + "\n")
        .toString()
        .trim()
    );
    this.run(dir, ["update-ref", `refs/heads/${branch}`, commitSha, parent]);
    const commit = {
      sha: commitSha,
      branch,
      summary,
      version,
      files: {},
      source: { fileId, checksum, path }
    };
    state.commits.push(commit);
    state.branches[branch] = commitSha;
    this.verify(state, id);
    return commit;
  }
  publishReady(state: RepositoryState, id: string) {
    this.verify(state, id);
    if (!state.local) return;
    const dir = this.directory(id, state.local.generation);
    const flush = (path: string) => {
      if (lstatSync(path).isDirectory())
        for (const name of readdirSync(path)) flush(join(path, name));
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    flush(dir);
    for (const path of [resolve(dir, ".."), this.rootPath()]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  diff(state: RepositoryState, id: string) {
    this.verify(state, id);
    if (!state.local) return [];
    const dir = this.directory(id, state.local.generation);
    return state.commits.map(c => ({
      sha: c.sha,
      patch: this.run(dir, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `${sha(c.sha)}^`,
        c.sha,
        "--"
      ]).toString("utf8")
    }));
  }
  commit(): never {
    return fail("GIT_SOURCE_ARTIFACT_REQUIRED");
  }
  runCheck(): never {
    return fail("REAL_CHECK_NOT_AVAILABLE");
  }
  createPullRequest(): never {
    return fail("REMOTE_PR_NOT_AVAILABLE");
  }
  uploadArtifact(): never {
    return fail("REAL_FILE_REQUIRED");
  }
}
