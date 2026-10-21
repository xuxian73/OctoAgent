import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  Files,
  FileUpload,
  ByteScanner
} from "../packages/database/src/files.js";
import { Authorization } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { seedIdentities } from "./fixtures/identity.js";
import { Requirements } from "../packages/database/src/requirements.js";
import { fileRoute } from "../apps/server/src/files.js";
import { setup } from "./fixtures/contracts.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
const scanner: ByteScanner = {
  name: "explicit-test-only",
  simulated: true,
  scan: () => "clean"
};
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(readFileSync("packages/database/schema/baseline.sql", "utf8"));
  seedIdentities(db);
  const auth = new Authorization(new SqliteIdentityStore(db));
  const token = auth.issueUserSession("buyer");
  const req = new Requirements(db, auth).create(token, "project-a", {
    values: {},
    publicFields: []
  });
  const input: FileUpload = {
    kind: "requirement",
    resourceId: req.id,
    version: 0,
    revision: 1,
    milestoneId: "",
    sha: "",
    name: "source.ts",
    mime: "text/plain",
    requestKey: "request-1"
  };
  return { db, auth, token, input, files: new Files(db, auth, scanner) };
}
test("real temporary file bytes survive reopen; scanner required; exact digest and immutable object", () => {
  const dir = mkdtempSync(join(tmpdir(), "octo-files-"));
  const path = join(dir, "private.sqlite");
  const f = fixture(path);
  try {
    const source = join(dir, "source.ts");
    writeFileSync(source, "export const value = '字节';\r\n");
    const bytes = readFileSync(source);
    const result = f.files.upload(f.token, f.input, bytes);
    const id = String(result.id);
    assert.equal(result.size, bytes.length);
    assert.equal(
      result.checksum,
      createHash("sha256")
        .update(bytes)
        .digest("hex")
    );
    assert.equal(result.scan_status, "quarantined");
    assert.throws(() => f.files.download(f.token, id), /FILE_SCAN_BLOCKED/);
    new Files(f.db, f.auth).scan(id);
    assert.equal(f.files.metadata(f.token, id).scan_status, "unverifiable");
    f.files.scan(id);
    assert.equal(f.files.metadata(f.token, id).simulated, 1);
    assert.deepEqual(f.files.download(f.token, id).bytes, bytes);
    assert.deepEqual(
      f.files.upload(f.token, f.input, bytes),
      f.files.metadata(f.token, id)
    );
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE private_files SET bytes = ? WHERE id = ?")
          .run(Buffer.from("replace"), id),
      /Immutable/
    );
    f.db.close();
    const reopened = new DatabaseSync(path);
    try {
      const auth = new Authorization(new SqliteIdentityStore(reopened));
      assert.deepEqual(
        new Files(reopened, auth).download(f.token, id).bytes,
        bytes
      );
      const outsider = auth.issueUserSession("outsider");
      assert.throws(
        () => new Files(reopened, auth).download(outsider, id),
        /无权访问/
      );
      reopened.exec(
        "DELETE FROM resource_grants WHERE user_id = 'buyer' AND action = 'read'"
      );
      assert.throws(
        () => new Files(reopened, auth).download(f.token, id),
        /无权访问/
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (f.db.isOpen) f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("reject traversal, symlink paths, types, forgery, size/count, stale versions and reused keys; rollback registration failure", () => {
  const f = fixture();
  const bytes = Buffer.from("hello");
  const dir = mkdtempSync(join(tmpdir(), "octo-link-"));
  try {
    symlinkSync("/etc/passwd", join(dir, "link.txt"));
    for (const name of [
      "../secret.txt",
      "..\\secret.txt",
      "/etc/passwd",
      join(dir, "link.txt"),
      "bad\r\n.txt"
    ])
      assert.throws(
        () => f.files.upload(f.token, { ...f.input, name }, bytes),
        /INVALID_FILE/
      );
    for (const name of ["file.exe", "archive.tar", "file.pdf"])
      assert.throws(
        () => f.files.upload(f.token, { ...f.input, name }, bytes),
        /FILE_TYPE/
      );
    assert.throws(
      () =>
        f.files.upload(
          f.token,
          { ...f.input, name: "a.json", mime: "application/json" },
          bytes
        ),
      /FILE_TYPE/
    );
    assert.throws(
      () => f.files.upload(f.token, f.input, Buffer.from([0xff, 0])),
      /FILE_TYPE/
    );
    assert.throws(
      () => f.files.upload(f.token, { ...f.input, checksum: "forged" }, bytes),
      /CHECKSUM/
    );
    assert.throws(
      () => f.files.upload(f.token, { ...f.input, revision: 99 }, bytes),
      /STALE/
    );
    assert.throws(
      () =>
        new Files(f.db, f.auth, scanner, { maxBytes: 2 }).upload(
          f.token,
          f.input,
          bytes
        ),
      /SIZE_LIMIT/
    );
    f.db.exec(
      "CREATE TRIGGER fail_file BEFORE INSERT ON private_files BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    );
    assert.throws(() => f.files.upload(f.token, f.input, bytes), /injected/);
    assert.equal(
      f.files.list(f.token, "requirement", f.input.resourceId).length,
      0
    );
    f.db.exec("DROP TRIGGER fail_file");
    const first = f.files.upload(f.token, f.input, bytes);
    assert.throws(
      () => f.files.upload(f.token, f.input, Buffer.from("different")),
      /REQUEST_KEY_REUSED/
    );
    assert.throws(
      () =>
        new Files(f.db, f.auth, scanner, { maxCount: 1 }).upload(
          f.token,
          { ...f.input, requestKey: "request-2" },
          bytes
        ),
      /COUNT_LIMIT/
    );
    const second = f.files.upload(
      f.token,
      { ...f.input, requestKey: "request-2" },
      bytes
    );
    assert.notEqual(first.id, second.id);
    new Files(f.db, f.auth, {
      ...scanner,
      scan: () => {
        throw new Error();
      }
    }).scan(String(first.id));
    assert.equal(
      f.files.metadata(f.token, String(first.id)).scan_status,
      "failed"
    );
    assert.throws(() => f.files.download(f.token, String(first.id)), /BLOCKED/);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP concurrent retries, raw download headers and per-request revoked authorization", async () => {
  const f = fixture();
  async function request(
    path: string,
    method: string,
    headers: Record<string, string>,
    body = ""
  ) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      url: path,
      method,
      rawHeaders: Object.entries(headers).flat(),
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      )
    }) as IncomingMessage;
    let output = Buffer.alloc(0);
    const responseHeaders: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader(key: string, value: unknown) {
        responseHeaders[key.toLowerCase()] = String(value);
      },
      end(value: string | Buffer) {
        output = Buffer.from(value);
      }
    };
    await fileRoute(req, (res as unknown) as ServerResponse, "test", f.files);
    return {
      status: res.statusCode,
      headers: { get: (key: string) => responseHeaders[key] },
      json: async () => JSON.parse(output.toString()),
      arrayBuffer: async () => output
    };
  }
  const base = "/api/files";
  const headers = {
    Authorization: `Bearer ${f.token}`,
    "Content-Type": "application/octet-stream",
    "X-File-Metadata": encodeURIComponent(JSON.stringify(f.input))
  };
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(base, "POST", headers, "actual bytes\r\n")
      )
    );
    const results = await Promise.all(responses.map(r => r.json()));
    assert.ok(results.every(r => r.ok));
    assert.equal(new Set(results.map(r => r.data.id)).size, 1);
    const id = results[0].data.id;
    assert.equal(
      (await request(`${base}/${id}/download`, "GET", headers)).status,
      409
    );
    f.files.scan(id);
    const response = await request(`${base}/${id}/download`, "GET", headers);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from("actual bytes\r\n")
    );
    assert.equal(
      (await request(`${base}/${id}/download`, "GET", {})).status,
      403
    );
    f.db.exec("UPDATE credentials SET revoked = 1");
    assert.equal(
      (await request(`${base}/${id}/download`, "GET", headers)).status,
      403
    );
  } finally {
    f.db.close();
  }
});
test("contract artifact binding and scan gate apply at import", () => {
  const f = setup();
  f.activate();
  const id = f.current().id;
  const workspace = new Workspaces(f.db, f.auth);
  const command = (action: string, extra: Record<string, unknown>) =>
    workspace.command(f.seller, id, {
      version: 1,
      requestKey: action + JSON.stringify(extra),
      action,
      ...extra
    });
  try {
    for (const permission of [
      "branch",
      "commit",
      "artifact",
      "check",
      "pull_request",
      "submit"
    ])
      workspace.command(f.buyer, id, {
        action: "authorize",
        version: 1,
        requestKey: permission,
        actorId: "seller",
        permission,
        ttlMs: 900000,
        confirmed: true
      });
    command("create_workspace_branch", { branch: "delivery" });
    command("commit", {
      branch: "delivery",
      summary: "code",
      files: { "a.ts": "export {};" }
    });
    const sha = workspace.read(f.buyer, id).commits[0]!.sha;
    const files = new Files(f.db, f.auth, scanner);
    const input: FileUpload = {
      kind: "artifact",
      resourceId: id,
      version: 1,
      revision: 0,
      milestoneId: String(f.current().milestones[0]!.id),
      sha,
      name: "build.txt",
      mime: "text/plain",
      requestKey: "artifact-1"
    };
    const file = files.upload(f.seller, input, Buffer.from("build"));
    const args = { fileId: file.id, sha, milestoneId: input.milestoneId };
    assert.throws(() => command("upload_artifact", args), /SCAN_BLOCKED/);
    files.scan(String(file.id));
    assert.throws(() => files.download(f.second, String(file.id)), /无权访问/);
    assert.throws(
      () => command("upload_artifact", { ...args, milestoneId: "other" }),
      /BINDING/
    );
    command("upload_artifact", args);
    assert.equal(workspace.read(f.buyer, id).artifacts[0]!.fileId, file.id);
    command("run_check", { sha, kind: "test" });
    command("run_check", { sha, kind: "typecheck" });
    command("create_pull_request", { sha });
    const submission = {
      sha,
      milestoneId: input.milestoneId,
      summary: "verified bytes"
    };
    new Files(f.db, f.auth, { ...scanner, scan: () => "infected" }).scan(
      String(file.id)
    );
    assert.throws(
      () => command("submit_milestone", submission),
      /SCAN_BLOCKED/
    );
    new Files(f.db, f.auth).scan(String(file.id));
    assert.throws(
      () => command("submit_milestone", submission),
      /SCAN_BLOCKED/
    );
    files.scan(String(file.id));
    command("submit_milestone", submission);
    assert.equal(
      (workspace.read(f.buyer, id).submissions[0] as { simulated: boolean })
        .simulated,
      true
    );

    assert.throws(
      () =>
        files.upload(
          f.seller,
          { ...input, resourceId: "contract-b" },
          Buffer.from("build")
        ),
      /无权访问/
    );
  } finally {
    f.db.close();
  }
});

test("interrupted request never registers partial bytes; legacy metadata stays non-downloadable", async () => {
  const f = fixture();
  try {
    const req = (Object.assign(
      Readable.from(
        (async function*() {
          yield Buffer.from("partial");
          throw new Error("disconnect");
        })()
      ),
      {
        method: "POST",
        url: "/api/files",
        rawHeaders: ["Authorization", `Bearer ${f.token}`],
        headers: {
          "content-type": "application/octet-stream",
          "x-file-metadata": encodeURIComponent(JSON.stringify(f.input))
        }
      }
    ) as unknown) as IncomingMessage;
    let status = 200;
    const res = ({
      get statusCode() {
        return status;
      },
      set statusCode(value: number) {
        status = value;
      },
      setHeader() {},
      end() {}
    } as unknown) as ServerResponse;
    await fileRoute(req, res, "interrupted", f.files);
    assert.equal(status, 500);
    assert.equal(
      f.files.list(f.token, "requirement", f.input.resourceId).length,
      0
    );
    assert.equal(
      f.files.upload(f.token, f.input, Buffer.from("complete")).size,
      8
    );
    const service = new Requirements(f.db, f.auth);
    const legacy = service.addAttachment(f.token, f.input.resourceId, {
      revision: 1,
      name: "old.txt",
      mime: "text/plain",
      size: 50
    });
    const metadata = service.attachment(f.token, f.input.resourceId, legacy.id);
    assert.equal(metadata.hasBytes, 0);
    assert.equal(metadata.scan_status, "legacy_metadata_only");
    assert.throws(() => f.files.download(f.token, legacy.id), /无权访问/);
  } finally {
    f.db.close();
  }
});
