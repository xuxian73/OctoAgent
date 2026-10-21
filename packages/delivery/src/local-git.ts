import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { checksum, RepositoryState, safePath, text } from "./github.js";
import { RequirementError } from "../../requirements/src/model.js";

/** Published generations are immutable. SQLite's writer lock serializes publication.
 * An interrupted/unpublished generation is rebuilt on retry; no ref in a published
 * generation is ever advanced before the database transaction commits. */
export class LocalGitProvider {
  constructor(
    private root = process.env.WORKSPACE_GIT_ROOT,
    private executable = "/usr/bin/git"
  ) {}
  private directory(id: string, generation: string) {
    if (!this.root || !isAbsolute(this.root))
      throw new RequirementError("GIT_ROOT_NOT_CONFIGURED", 503);
    if (!/^[a-f0-9]{64}$/.test(generation))
      throw new RequirementError("GIT_STATE_CORRUPT", 409);
    const base = resolve(this.root);
    // Reject symlinks including any ancestor of the deployment root.
    let current = base;
    while (current !== resolve(current, "..")) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new RequirementError("GIT_UNSAFE_PATH", 409);
      current = resolve(current, "..");
    }
    const path = join(base, checksum(id), generation);
    for (const p of [join(base, checksum(id)), path])
      if (existsSync(p) && lstatSync(p).isSymbolicLink())
        throw new RequirementError("GIT_UNSAFE_PATH", 409);
    return path;
  }
  private safeTree(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new RequirementError("GIT_UNSAFE_PATH", 409);
      if (entry.isFile() && lstatSync(child).nlink !== 1)
        throw new RequirementError("GIT_UNSAFE_PATH", 409);
      if (entry.isDirectory()) this.safeTree(child);
    }
  }
  private git(path: string, args: string[], input?: Uint8Array) {
    const result = spawnSync(
      this.executable,
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-c",
        "diff.external=",
        "-C",
        path,
        ...args
      ],
      {
        input,
        encoding: "buffer",
        timeout: 15000,
        maxBuffer: 24 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          XDG_CONFIG_HOME: "/nonexistent",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
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
    if (result.error || result.status !== 0)
      throw new RequirementError(
        result.error && "code" in result.error && result.error.code === "ENOENT"
          ? "GIT_UNAVAILABLE"
          : "GIT_OPERATION_FAILED",
        503
      );
    return result.stdout;
  }
  private validate(path: string) {
    if (!existsSync(join(path, ".git")))
      throw new RequirementError("GIT_REPOSITORY_MISSING", 409);
    this.safeTree(path);
    if (
      !lstatSync(join(path, ".git")).isDirectory() ||
      !existsSync(join(path, ".git/config"))
    )
      throw new RequirementError("GIT_REPOSITORY_CORRUPT", 409);
    // No repository-controlled config, includes, helpers, alternates or redirects.
    const config = readFileSync(join(path, ".git/config"), "utf8");
    if (config !== this.config)
      throw new RequirementError("GIT_UNSAFE_CONFIG", 409);
    if (
      existsSync(join(path, ".git/objects/info/alternates")) ||
      existsSync(join(path, ".git/commondir")) ||
      existsSync(join(path, ".git/info/grafts"))
    )
      throw new RequirementError("GIT_UNSAFE_CONFIG", 409);
    this.git(path, ["fsck", "--full", "--no-reflogs"]);
  }
  private config =
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n";
  verify(id: string, state: RepositoryState) {
    if (!state.localGit) return;
    const path = this.directory(id, state.localGit.generation);
    this.validate(path);
    if (
      this.git(path, ["status", "--porcelain", "--untracked-files=all"]).length
    )
      throw new RequirementError("GIT_WORKTREE_DIRTY", 409);
    for (const [branch, sha] of Object.entries(state.branches)) {
      this.branch(branch);
      if (
        this.git(path, ["rev-parse", "--verify", `refs/heads/${branch}`])
          .toString()
          .trim() !== sha
      )
        throw new RequirementError("GIT_STATE_CORRUPT", 409);
    }
    for (const commit of state.commits) {
      if (!/^[a-f0-9]{40}$/.test(commit.sha))
        throw new RequirementError("GIT_STATE_CORRUPT", 409);
      this.git(path, ["cat-file", "-e", commit.sha + "^{commit}"]);
      if (!commit.source) throw new RequirementError("GIT_STATE_CORRUPT", 409);
      safePath(commit.source.path);
      if (
        checksum(
          this.git(path, [
            "cat-file",
            "blob",
            `${commit.sha}:${commit.source.path}`
          ])
        ) !== commit.source.checksum ||
        this.git(path, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          `${commit.sha}^`,
          commit.sha,
          "--"
        ]).toString("utf8") !== commit.diff
      )
        throw new RequirementError("GIT_STATE_CORRUPT", 409);
    }
  }
  private branch(value: string) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/.test(value) ||
      value.includes("//") ||
      value.endsWith("/") ||
      value
        .split("/")
        .some(x => ["__proto__", "constructor", "prototype"].includes(x))
    )
      throw new RequirementError("INVALID_BRANCH");
    return value;
  }
  operate(
    id: string,
    state: RepositoryState,
    operation: string,
    action: string,
    branch: string,
    summary: string,
    version: number,
    file?: { path: string; bytes: Uint8Array; id: string; checksum: string }
  ) {
    if (
      (state.commits.length || Object.keys(state.branches).length) &&
      !state.localGit
    )
      throw new RequirementError("LEGACY_SIMULATION_READ_ONLY", 409);
    this.verify(id, state);
    if (action !== "initialize_repository" && !state.localGit)
      throw new RequirementError("GIT_INITIALIZATION_REQUIRED", 409);
    if (action === "initialize_repository" && state.localGit)
      throw new RequirementError("GIT_ALREADY_INITIALIZED", 409);
    if (action !== "initialize_repository") this.branch(branch);
    if (file) {
      safePath(file.path);
      if (file.path.startsWith("-")) throw new RequirementError("INVALID_PATH");
    }
    const generation = checksum(JSON.stringify([state.localGit, operation]));
    const path = this.directory(id, generation);
    if (existsSync(path)) {
      this.safeTree(path);
      rmSync(path, { recursive: true });
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (state.localGit)
      cpSync(this.directory(id, state.localGit.generation), path, {
        recursive: true
      });
    else {
      this.git(path, ["init", "--template=", "--initial-branch=main"]);
      writeFileSync(join(path, ".git/config"), this.config);
      this.git(path, [
        "commit",
        "--allow-empty",
        "-m",
        "Initialize isolated repository"
      ]);
      state.branches.main = this.git(path, ["rev-parse", "HEAD"])
        .toString()
        .trim();
    }
    let result: unknown = { initialized: true };
    if (action === "create_workspace_branch") {
      if (Object.hasOwn(state.branches, branch))
        throw new RequirementError("BRANCH_EXISTS", 409);
      this.git(path, ["branch", branch, "refs/heads/main"]);
      state.branches[branch] = state.branches.main!;
      result = { branch };
    } else if (action === "commit") {
      if (!Object.hasOwn(state.branches, branch) || !file)
        throw new RequirementError("BRANCH_OR_ARTIFACT_REQUIRED");
      this.git(path, ["checkout", branch]);
      const target = join(path, file.path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, file.bytes);
      this.git(path, ["add", "--", file.path]);
      this.git(path, ["commit", "--allow-empty", "-m", text(summary)]);
      const sha = this.git(path, ["rev-parse", "HEAD"])
        .toString()
        .trim();
      const diff = this.git(path, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD^",
        "HEAD",
        "--"
      ]).toString("utf8");
      result = {
        sha,
        branch,
        summary,
        version,
        files: {},
        diff,
        source: { fileId: file.id, checksum: file.checksum, path: file.path }
      };
      state.commits.push(result as RepositoryState["commits"][number]);
      state.branches[branch] = sha;
    }
    state.localGit = { generation };
    this.verify(id, state);
    return result;
  }
}
