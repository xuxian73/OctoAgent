import { Scanner, scanFile } from "../../security/src/index.js";
import { createHash } from "node:crypto";
import { ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
export const permissions = [
  "branch",
  "commit",
  "check",
  "pull_request",
  "artifact",
  "submit",
  "discussion"
] as const;
export type Permission = typeof permissions[number];
export interface RepositoryState {
  local?: { contractId: string; generation: string };
  branches: Record<string, string>;
  commits: {
    sha: string;
    branch: string;
    summary: string;
    version: number;
    files: Record<string, string>;
    source?: { fileId: string; checksum: string; path: string };
  }[];
  checks: { sha: string; kind: string; passed: boolean; log: string }[];
  pullRequests: { sha: string; url: string; summary: string }[];
  artifacts: {
    sha: string;
    name: string;
    checksum: string;
    size: number;
    fileId?: string;
    simulated?: boolean;
    hasBytes?: boolean;
    milestoneId?: string;
  }[];
  discussions: string[];
  risks: string[];
  deployments: unknown[];
  submissions: unknown[];
}
export function text(value: unknown): string {
  const content = fileContent(value);
  if (!content.trim()) throw new RequirementError("INVALID_TEXT");
  return content.trim();
}
// File contents are validated without normalization: whitespace and empty files matter.
function fileContent(value: unknown): string {
  if (typeof value !== "string" || value.length > 10000)
    throw new RequirementError("INVALID_TEXT");
  // Never persist credential-shaped or personal data in delivery text.
  if (
    /bearer\s|(?:cookie|token|password|secret)["']?\s*[:=]|PRIVATE KEY|gh[pousr]_|github_pat_|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(
      value
    )
  )
    throw new RequirementError("SENSITIVE_CONTENT");
  return value;
}
export function safePath(value: unknown): string {
  const path = text(value);
  if (
    !/^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/.test(path) ||
    path.split("/").some(p => p.startsWith(".")) ||
    path.includes("..") ||
    path
      .split("/")
      .some(p => ["__proto__", "prototype", "constructor"].includes(p))
  )
    throw new RequirementError("INVALID_PATH");
  return path;
}
export const checksum = (value: string) =>
  createHash("sha256")
    .update(value)
    .digest("hex");
export interface GitHubProvider {
  authorize(permission: Permission, granted: readonly string[]): void;
  createBranch(state: RepositoryState, branch: string): unknown;
  commit(
    state: RepositoryState,
    branch: string,
    files: Record<string, string>,
    summary: string,
    version: number
  ): unknown;
  runCheck(state: RepositoryState, sha: string, kind: string): unknown;
  createPullRequest(state: RepositoryState, sha: string): unknown;
  uploadArtifact(
    state: RepositoryState,
    sha: string,
    name: string,
    content: string,
    digest: string
  ): unknown;
}
// Deterministic, isolated virtual Git repository. No shell, network, or production adapter.
export class FakeGitHubProvider implements GitHubProvider {
  constructor(private scanner: Scanner = { scan: () => "unavailable" }) {}
  authorize(permission: Permission, granted: readonly string[]) {
    if (!granted.includes(permission)) throw new ForbiddenError();
  }
  createBranch(state: RepositoryState, branch: string) {
    safePath(branch);
    if (Object.hasOwn(state.branches, branch))
      throw new RequirementError("BRANCH_EXISTS", 409);
    state.branches[branch] = "";
    return { branch };
  }
  commit(
    state: RepositoryState,
    branch: string,
    files: Record<string, string>,
    summary: string,
    version: number
  ) {
    if (!Object.hasOwn(state.branches, branch))
      throw new RequirementError("BRANCH_REQUIRED");
    if (
      !files ||
      typeof files !== "object" ||
      Array.isArray(files) ||
      !Object.keys(files).length ||
      Object.keys(files).length > 50
    )
      throw new RequirementError("INVALID_FILES");
    const clean = Object.fromEntries(
      Object.entries(files).map(([p, v]) => [safePath(p), fileContent(v)])
    );
    const commit = {
      sha: checksum(
        JSON.stringify([
          branch,
          state.branches[branch],
          clean,
          summary,
          version
        ])
      ),
      branch,
      files: clean,
      summary: text(summary),
      version
    };
    state.commits.push(commit);
    state.branches[branch] = commit.sha;
    return commit;
  }
  runCheck(state: RepositoryState, sha: string, kind: string) {
    const commit = state.commits.find(c => c.sha === sha);
    if (!commit || !["test", "typecheck"].includes(kind))
      throw new RequirementError("INVALID_CHECK");
    const passed = !Object.values(commit.files).some(v =>
      v.includes(`FAKE_FAIL_${kind}`)
    );
    const check = {
      sha,
      kind,
      passed,
      log: `离线模拟 ${kind}: ${passed ? "PASS" : "FAIL"}（不执行仓库代码）`
    };
    state.checks.push(check);
    return check;
  }
  createPullRequest(state: RepositoryState, sha: string) {
    const commit = state.commits.find(c => c.sha === sha);
    if (!commit) throw new RequirementError("COMMIT_REQUIRED");
    const existing = state.pullRequests.find(p => p.sha === sha);
    if (existing) return existing;
    const pr = {
      sha,
      summary: commit.summary,
      url: `https://github.invalid/offline/pull/${sha}`
    };
    state.pullRequests.push(pr);
    return pr;
  }
  uploadArtifact(
    state: RepositoryState,
    sha: string,
    name: string,
    content: string,
    digest: string
  ) {
    if (!state.commits.some(c => c.sha === sha))
      throw new RequirementError("COMMIT_REQUIRED");
    safePath(name);
    text(content);
    scanFile(
      {
        name,
        mime: "text/plain",
        size: Buffer.byteLength(content),
        content: Buffer.from(content)
      },
      this.scanner
    );
    if (checksum(content) !== digest)
      throw new RequirementError("CHECKSUM_MISMATCH");
    const artifact = {
      sha,
      name,
      checksum: digest,
      size: Buffer.byteLength(content),
      simulated: true,
      hasBytes: false
    };
    state.artifacts.push(artifact);
    return artifact;
  }
}
