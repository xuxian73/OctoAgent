import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { ForbiddenError } from "../../auth/src/index.js";
import { RequirementError } from "../../requirements/src/model.js";
export type RemoteScope = "read" | "write" | "create_pr";
export interface GitHubProfile {
  id: string;
  contractId: string;
  responsibleUserId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  base: string;
  credentialEnv: string;
  allowed: RemoteScope[];
  expiresAt: number;
}
export function remoteFail(code = "GITHUB_IDENTITY_MISMATCH"): never {
  throw new RequirementError(code, 409);
}
export const gitHash = (kind: string, content: string | Buffer) => {
  const bytes = Buffer.from(content);
  return createHash("sha1")
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};
export function loadGitHubProfiles(): GitHubProfile[] {
  const path = process.env.OCTO_GITHUB_CONFIG;
  if (!path) return [];
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error();
    const profiles = JSON.parse(readFileSync(path, "utf8")) as GitHubProfile[];
    if (
      !Array.isArray(profiles) ||
      new Set(profiles.map(p => p.id)).size !== profiles.length
    )
      throw new Error();
    for (const p of profiles) {
      if (
        ![p.id, p.owner, p.repo, p.base].every(
          v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v)
        ) ||
        !p.contractId ||
        !p.responsibleUserId ||
        !Number.isSafeInteger(p.repositoryId) ||
        p.repositoryId <= 0 ||
        !/^OCTO_GITHUB_CREDENTIAL_[A-Z0-9_]+$/.test(p.credentialEnv) ||
        !Number.isSafeInteger(p.expiresAt) ||
        !Array.isArray(p.allowed) ||
        p.allowed.some(s => !["read", "write", "create_pr"].includes(s))
      )
        throw new Error();
    }
    return profiles;
  } catch {
    return remoteFail("GITHUB_CONFIGURATION_INVALID");
  }
}
export function profileDigest(p: GitHubProfile) {
  return createHash("sha256")
    .update(JSON.stringify(p))
    .digest("hex");
}
// Only server-injected credentials. Never consult gh, git helpers, browser storage or redirects.
export class GitHubRest {
  constructor(
    private credential: (ref: string) => string | undefined = ref =>
      process.env[ref],
    private origin = "https://api.github.com",
    private transport: typeof fetch = fetch
  ) {
    if (
      origin !== "https://api.github.com" &&
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
    )
      remoteFail("GITHUB_ORIGIN_INVALID");
  }
  async request(
    p: GitHubProfile,
    path: string,
    guard: () => void,
    method = "GET",
    body?: unknown,
    missing = false
  ): Promise<any> {
    guard();
    const secret = this.credential(p.credentialEnv);
    if (!secret) throw new ForbiddenError();
    try {
      const response = await this.transport(
        `${this.origin}/repos/${p.owner}/${p.repo}${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${secret}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        }
      );
      guard();
      if (missing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return remoteFail("GITHUB_REMOTE_ERROR");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          return remoteFail("GITHUB_RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
      guard();
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      if (e instanceof RequirementError || e instanceof ForbiddenError) throw e;
      return remoteFail("GITHUB_REMOTE_ERROR");
    }
  }
  async repository(p: GitHubProfile, guard: () => void) {
    const r = await this.request(p, "", guard);
    if (
      r.id !== p.repositoryId ||
      r.full_name !== `${p.owner}/${p.repo}` ||
      r.html_url !== `https://github.com/${p.owner}/${p.repo}`
    )
      remoteFail();
  }
  async ref(
    p: GitHubProfile,
    branch: string,
    guard: () => void,
    missing = false
  ) {
    const r = await this.request(
      p,
      `/git/ref/heads/${encodeURIComponent(branch)}`,
      guard,
      "GET",
      undefined,
      missing
    );
    if (r === null) return null;
    if (
      r.ref !== `refs/heads/${branch}` ||
      r.object?.type !== "commit" ||
      !/^[a-f0-9]{40}$/.test(r.object.sha)
    )
      remoteFail();
    return r.object.sha as string;
  }
  // Full snapshots may only preserve or add baseline paths. Deletion is
  // deliberately unavailable, even to an agent holding write permission.
  async assertNoDeletions(
    p: GitHubProfile,
    baseSha: string,
    snapshot: { files: { path: string }[] },
    guard: () => void
  ) {
    const commit = await this.request(p, `/git/commits/${baseSha}`, guard);
    if (commit.sha !== baseSha || !/^[a-f0-9]{40}$/.test(commit.tree?.sha))
      remoteFail();
    const tree = await this.request(
      p,
      `/git/trees/${commit.tree.sha}?recursive=1`,
      guard
    );
    if (
      tree.sha !== commit.tree.sha ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree)
    )
      remoteFail("GITHUB_BASE_TREE_INCOMPLETE");
    const paths = new Set(snapshot.files.map(f => f.path));
    const removed: string[] = [];
    const seen = new Set<string>();
    for (const entry of tree.tree) {
      if (
        typeof entry.path !== "string" ||
        !entry.path ||
        seen.has(entry.path) ||
        !["tree", "blob", "commit"].includes(entry.type)
      )
        remoteFail();
      seen.add(entry.path);
      if (entry.type !== "tree" && !paths.has(entry.path))
        removed.push(entry.path);
    }
    if (removed.length)
      remoteFail("GITHUB_DELETION_DISABLED: " + JSON.stringify(removed.sort()));
  }
  async sync(
    p: GitHubProfile,
    plan: {
      branch: string;
      baseSha: string;
      remoteSha: string;
      message: string;
    },
    snapshot: {
      tree: string;
      files: { path: string; sha: string; content: string }[];
    },
    guard: () => void
  ) {
    await this.repository(p, guard);
    await this.assertNoDeletions(p, plan.baseSha, snapshot, guard);
    const existing = await this.ref(p, plan.branch, guard, true);
    if (existing && existing !== plan.remoteSha) remoteFail();
    if (!existing) {
      for (const file of snapshot.files) {
        const blob = await this.request(p, "/git/blobs", guard, "POST", {
          content: file.content,
          encoding: "base64"
        });
        if (blob.sha !== file.sha) remoteFail();
      }
      const tree = await this.request(p, "/git/trees", guard, "POST", {
        tree: snapshot.files.map(f => ({
          path: f.path,
          mode: "100644",
          type: "blob",
          sha: f.sha
        }))
      });
      if (tree.sha !== snapshot.tree) remoteFail();
      const person = {
        name: "OctoAgent",
        email: "local@invalid",
        date: "2000-01-01T00:00:00Z"
      };
      const commit = await this.request(p, "/git/commits", guard, "POST", {
        message: plan.message,
        tree: snapshot.tree,
        parents: [plan.baseSha],
        author: person,
        committer: person
      });
      if (commit.sha !== plan.remoteSha) remoteFail();
      try {
        await this.request(p, "/git/refs", guard, "POST", {
          ref: `refs/heads/${plan.branch}`,
          sha: plan.remoteSha
        });
      } catch (e) {
        // Lost response or competing create: only the exact immutable ref is recoverable.
        if ((await this.ref(p, plan.branch, guard, true)) !== plan.remoteSha)
          throw e;
      }
    }
    await this.verifyCommit(p, plan, snapshot.tree, guard);
  }
  async verifyCommit(
    p: GitHubProfile,
    plan: {
      branch: string;
      remoteSha: string;
      baseSha: string;
      message: string;
    },
    tree: string,
    guard: () => void
  ) {
    if ((await this.ref(p, plan.branch, guard)) !== plan.remoteSha)
      remoteFail();
    const c = await this.request(p, `/git/commits/${plan.remoteSha}`, guard);
    if (
      c.sha !== plan.remoteSha ||
      c.tree?.sha !== tree ||
      c.message !== plan.message ||
      c.parents?.length !== 1 ||
      c.parents[0].sha !== plan.baseSha
    )
      remoteFail();
  }
  async pullRequest(
    p: GitHubProfile,
    plan: { branch: string; remoteSha: string },
    guard: () => void
  ) {
    const find = async () => {
      const rows = await this.request(
        p,
        `/pulls?state=all&head=${encodeURIComponent(
          p.owner + ":" + plan.branch
        )}&base=${encodeURIComponent(p.base)}&per_page=100`,
        guard
      );
      if (!Array.isArray(rows) || rows.length > 1) remoteFail();
      return rows[0];
    };
    let pr = await find();
    if (!pr) {
      try {
        pr = await this.request(p, "/pulls", guard, "POST", {
          title: "OctoAgent code delivery",
          head: plan.branch,
          base: p.base,
          body:
            "Explicitly authorized delivery snapshot. Review changes before merging."
        });
      } catch (e) {
        pr = await find();
        if (!pr) throw e;
      }
    }
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) remoteFail();
    const number = pr.number;
    pr = await this.request(p, `/pulls/${number}`, guard);
    if (
      pr.number !== number ||
      pr.head?.repo?.id !== p.repositoryId ||
      pr.base?.repo?.id !== p.repositoryId ||
      pr.head?.repo?.full_name !== `${p.owner}/${p.repo}` ||
      pr.base?.repo?.full_name !== `${p.owner}/${p.repo}` ||
      pr.head?.ref !== plan.branch ||
      pr.head?.sha !== plan.remoteSha ||
      pr.base?.ref !== p.base ||
      pr.html_url !==
        `https://github.com/${p.owner}/${p.repo}/pull/${pr.number}`
    )
      remoteFail();
    return {
      number: pr.number as number,
      url: pr.html_url as string,
      state: pr.state === "open" ? "open" : "closed"
    };
  }
  async checks(p: GitHubProfile, remoteSha: string, guard: () => void) {
    const result: {
      id: number;
      status: string;
      conclusion: string | null;
      remoteSha: string;
    }[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.request(
        p,
        `/commits/${remoteSha}/check-runs?per_page=100&page=${page}`,
        guard
      );
      if (
        !Array.isArray(data.check_runs) ||
        !Number.isSafeInteger(data.total_count)
      )
        remoteFail();
      for (const c of data.check_runs) {
        if (
          c.head_sha !== remoteSha ||
          !Number.isSafeInteger(c.id) ||
          ![
            "queued",
            "in_progress",
            "completed",
            "waiting",
            "pending",
            "requested"
          ].includes(c.status) ||
          ![
            null,
            "success",
            "failure",
            "neutral",
            "cancelled",
            "skipped",
            "timed_out",
            "action_required",
            "stale",
            "startup_failure"
          ].includes(c.conclusion)
        )
          remoteFail();
        if (result.some(r => r.id === c.id)) remoteFail();
        result.push({
          id: c.id,
          status: c.status,
          conclusion: c.conclusion,
          remoteSha
        });
      }
      if (result.length === data.total_count) return result;
      if (!data.check_runs.length) remoteFail();
    }
    return remoteFail("GITHUB_CHECKS_INCOMPLETE");
  }
}
