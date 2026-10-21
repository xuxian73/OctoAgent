import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setup } from "./fixtures/contracts.js";
import { zip } from "./fixtures/zip.js";
import {
  controlledScanner,
  stageZip,
  deliveryId
} from "./fixtures/delivery.js";
import { validateZip } from "../packages/security/src/zip.js";
import { Files } from "../packages/database/src/files.js";
import { Workspaces } from "../packages/database/src/workspaces.js";
import { Authorization } from "../packages/auth/src/index.js";
import { SqliteIdentityStore } from "../packages/database/src/identity.js";
import { MarketplaceMcp } from "../packages/mcp/src/index.js";
import { McpRequests } from "../packages/database/src/mcp.js";

test("ZIP structure, CRC, encryption, traversal, symlinks, nested limits and expansion fail closed", () => {
  validateZip(zip());
  // Produced independently with Python zipfile using DEFLATED, not our encoder.
  validateZip(
    Buffer.from(
      "UEsDBBQAAAAIAFoKVl1QHxHXHAAAABoAAAAJAAAAUkVBRE1FLm1kC0pNzFFISU3LSSxJTVGI8gxQSMusKCktSuUCAFBLAQIUAxQAAAAIAFoKVl1QHxHXHAAAABoAAAAJAAAAAAAAAAAAAACAAQAAAABSRUFETUUubWRQSwUGAAAAAAEAAQA3AAAAQwAAAAAA",
      "base64"
    )
  );
  assert.throws(() => validateZip(zip("")), /EMPTY/);
  for (const name of [
    "../outside",
    "/absolute",
    "C:/drive",
    "dir\\file",
    "a/../b",
    "a/.. /b",
    "NUL.txt"
  ])
    assert.throws(() => validateZip(zip("data", name)), /ZIP_/);
  const original = zip();
  const central = original.readUInt32LE(original.length - 6);
  const damaged = Buffer.from(original);
  damaged[30 + 10] = damaged[30 + 10]! ^ 1;
  assert.throws(() => validateZip(damaged), /ZIP_/);
  assert.throws(
    () => validateZip(original.subarray(0, original.length - 1)),
    /ZIP_/
  );
  const encrypted = Buffer.from(original);
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => validateZip(encrypted), /ENCRYPTED/);
  const symlink = Buffer.from(original);
  symlink.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => validateZip(symlink), /SPECIAL/);
  const bomb = Buffer.from(original);
  bomb.writeUInt32LE(30 * 1024 * 1024, central + 24);
  assert.throws(() => validateZip(bomb), /EXPANSION/);
  let nested = zip();
  for (let i = 0; i < 4; i++) nested = zip(nested, "nested.zip");
  assert.throws(() => validateZip(nested), /NESTING/);
});

test("real ZIP versions survive reopen; old confirmation and idempotency cannot accept rework; no Git provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-delivery-")),
    path = join(dir, "store.sqlite");
  const f = setup(path);
  f.activate();
  const id = f.current().id,
    m = String(f.current().milestones[0]!.id);
  const work = new Workspaces(f.db, f.auth, () => 1000);
  const files = new Files(f.db, f.auth, controlledScanner);
  try {
    const first = await stageZip(f, id, m);
    const firstBytes = files.download(f.buyer, String(first.fileId)).bytes;
    const input = {
      action: "submit_milestone",
      version: 1,
      requestKey: "first-submit",
      milestoneId: m,
      ...first
    };
    const submitted = work.command(f.seller, id, input);
    assert.deepEqual(work.command(f.seller, id, input), submitted);
    const firstId = deliveryId(f.db, m);
    let c = f.contracts.read(f.buyer, id);
    const review = {
      action: "milestone",
      version: 1,
      revision: c.revision,
      requestKey: "first-review",
      milestoneId: m,
      to: "changes_requested",
      confirmed: true,
      reason: { code: "rework", detail: "please revise" },
      deliveryId: firstId
    };
    f.contracts.command(f.buyer, id, review);
    assert.throws(
      () => work.command(f.seller, id, { ...input, requestKey: "reused-file" }),
      /FILE_ALREADY_SUBMITTED/
    );
    const second = await stageZip(f, id, m);
    const secondBytes = files.download(f.buyer, String(second.fileId)).bytes;
    assert.notDeepEqual(firstBytes, secondBytes);
    work.command(f.seller, id, {
      ...input,
      ...second,
      requestKey: "second-submit"
    });
    work.command(f.seller, id, input); // retry returns first result, never changes current milestone
    c = f.contracts.read(f.buyer, id);
    assert.equal(c.zipDeliveries.length, 2);
    assert.equal(c.milestones[0]!.status, "submitted");
    assert.throws(
      () =>
        f.contracts.command(f.buyer, id, {
          ...review,
          to: "accepted",
          requestKey: "stale-accept",
          revision: c.revision
        }),
      /STALE_DELIVERY/
    );
    f.contracts.command(f.buyer, id, review); // old rework key does not touch current submission
    assert.equal(
      f.contracts.read(f.buyer, id).milestones[0]!.status,
      "submitted"
    );
    const accepted = {
      ...review,
      to: "accepted",
      deliveryId: deliveryId(f.db, m),
      revision: c.revision,
      requestKey: "accept-current"
    };
    f.contracts.command(f.buyer, id, accepted);
    f.contracts.command(f.buyer, id, accepted);
    assert.throws(
      () => files.download(f.second, String(first.fileId)),
      /无权访问/
    );
    assert.deepEqual(
      files.download(f.buyer, String(first.fileId)).bytes,
      firstBytes
    );
    f.db.close();
    const reopened = new DatabaseSync(path);
    try {
      const auth = new Authorization(
        new SqliteIdentityStore(reopened),
        () => 1000
      );
      const persisted = new Files(reopened, auth);
      for (const [fileId, expected] of [
        [first.fileId, firstBytes],
        [second.fileId, secondBytes]
      ] as const) {
        const download = persisted.download(f.buyer, String(fileId));
        assert.deepEqual(download.bytes, expected);
        assert.equal(
          download.metadata.checksum,
          createHash("sha256")
            .update(expected)
            .digest("hex")
        );
      }
    } finally {
      reopened.close();
    }
  } finally {
    if (f.db.isOpen) f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP ZIP uses business permissions and real bytes; rescan, revocation and dispute prevent delivery", async () => {
  const f = setup();
  f.activate();
  const id = f.current().id,
    m = String(f.current().milestones[0]!.id);
  const workspaces = new Workspaces(f.db, f.auth, () => 1000),
    files = new Files(f.db, f.auth, controlledScanner);
  try {
    const prepared = await stageZip(f, id, m);
    const agent = f.auth.issueAgentToken(
      f.seller,
      "agent-a",
      ["read", "write"].map(action => ({
        kind: "contract" as const,
        resourceId: id,
        action: action as "read" | "write"
      }))
    );
    for (const permission of ["submit", "artifact"])
      f.db
        .prepare("INSERT INTO delivery_permissions VALUES (?,?,?,?)")
        .run(id, "agent-a", permission, Date.now() + 900000);
    const mcp = new MarketplaceMcp(
      {
        auth: f.auth,
        requirements: f.req,
        market: f.market,
        contracts: f.contracts,
        workspaces,
        requests: new McpRequests(f.db),
        files
      },
      () => 1000
    );
    const uploadBytes = zip("offline MCP delivery\n".repeat(800));
    const uploaded = mcp.call(agent, "upload_file", {
      request_id: randomUUID(),
      workspace_id: id,
      version: 1,
      milestone_id: m,
      name: "mcp.zip",
      content_base64: uploadBytes.toString("base64")
    });
    assert.equal(uploaded.error, undefined, JSON.stringify(uploaded));
    prepared.fileId = (uploaded.data as { id: string }).id;
    const metadataArgs = {
      request_id: randomUUID(),
      contract_id: id,
      file_id: prepared.fileId
    };
    mcp.call(agent, "get_file", metadataArgs);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(
      (mcp.call(agent, "get_file", metadataArgs).data as {
        scan_status: string;
      }).scan_status,
      "clean"
    );
    const roundtrip = mcp.call(agent, "download_file", {
      ...metadataArgs,
      request_id: randomUUID()
    });
    assert.equal(roundtrip.error, undefined, JSON.stringify(roundtrip));
    assert.deepEqual(
      Buffer.from(
        (roundtrip.data as { content_base64: string }).content_base64,
        "base64"
      ),
      uploadBytes
    );
    const args = {
      request_id: randomUUID(),
      workspace_id: id,
      version: 1,
      milestone_id: m,
      file_id: prepared.fileId,
      summary: "ZIP",
      instructions: "README",
      known_issues: "none"
    };
    assert.equal(
      mcp.call(agent, "submit_milestone", { ...args, sha: "fake" }).error?.code,
      "INVALID_SCHEMA"
    );
    const result = mcp.call(agent, "submit_milestone", args);
    assert.equal(result.status, "active", JSON.stringify(result));
    const get = {
      request_id: randomUUID(),
      contract_id: id,
      file_id: prepared.fileId
    };
    assert.equal(mcp.call(agent, "download_file", get).error, undefined);
    await new Files(f.db, f.auth, {
      ...controlledScanner,
      scan: () => "rejected"
    }).scan(String(prepared.fileId));
    assert.throws(
      () => files.download(f.buyer, String(prepared.fileId)),
      /SCAN_BLOCKED/
    );
    assert.equal(
      mcp.call(agent, "download_file", get).error?.code,
      "FILE_SCAN_BLOCKED"
    );
    let c = f.contracts.read(f.buyer, id);
    const review = {
      action: "milestone",
      version: 1,
      revision: c.revision,
      requestKey: randomUUID(),
      milestoneId: m,
      to: "accepted",
      deliveryId: deliveryId(f.db, m),
      confirmed: true,
      reason: { code: "manual", detail: "review" }
    };
    assert.throws(
      () => f.contracts.command(f.buyer, id, review),
      /SCAN_BLOCKED/
    );
    await files.scan(String(prepared.fileId));
    f.db
      .prepare(
        "UPDATE delivery_permissions SET expires_at=0 WHERE actor_id='agent-a'"
      )
      .run();
    assert.equal(
      mcp.call(agent, "submit_milestone", args).error?.code,
      "FORBIDDEN"
    );
    f.contracts.command(f.buyer, id, {
      ...review,
      action: "transition",
      to: "disputed"
    });
    assert.throws(
      () =>
        workspaces.command(f.seller, id, {
          action: "submit_milestone",
          version: 1,
          requestKey: randomUUID(),
          milestoneId: m,
          ...prepared
        }),
      /CONTRACT_NOT_ACTIVE/
    );
  } finally {
    f.db.close();
  }
});

test("formal HTTP APIs complete ZIP rework with independent organizations and concurrent submission", async () => {
  const { Readable } = await import("node:stream");
  const { handleRequest } = await import("../apps/server/src/app.js");
  const f = setup();
  f.activate();
  const id = f.current().id;
  // Seller has its own organization; contract participation is the sole buyer-side access.
  f.db.exec(
    "DELETE FROM memberships WHERE user_id='seller'; INSERT INTO memberships VALUES ('seller','org-b','','seller'); DELETE FROM resource_grants WHERE user_id='seller' AND resource_kind IN ('project','organization');"
  );
  const work = new Workspaces(f.db, f.auth),
    files = new Files(f.db, f.auth, controlledScanner);
  for (const permission of ["artifact", "submit"])
    work.command(f.buyer, id, {
      action: "authorize",
      version: 1,
      requestKey: randomUUID(),
      actorId: "seller",
      permission,
      ttlMs: 900000,
      confirmed: true
    });
  async function request(
    token: string,
    path: string,
    body?: unknown,
    metadata?: unknown
  ) {
    const chunks =
      body === undefined
        ? []
        : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
    const req = Readable.from(chunks) as import("node:http").IncomingMessage;
    req.url = path;
    req.method = body === undefined ? "GET" : "POST";
    req.headers = {
      "content-type": metadata
        ? "application/octet-stream"
        : "application/json",
      ...(metadata
        ? { "x-file-metadata": encodeURIComponent(JSON.stringify(metadata)) }
        : {})
    };
    req.rawHeaders = ["Authorization", "Bearer " + token];
    return new Promise<{ status: number; data: any; bytes: Buffer }>(
      resolve => {
        const res = {
          statusCode: 200,
          setHeader() {},
          end(value: string | Buffer) {
            const bytes = Buffer.from(value);
            let data;
            try {
              data = JSON.parse(bytes.toString()).data;
            } catch {}
            resolve({ status: res.statusCode, data, bytes });
          }
        };
        handleRequest(
          req,
          (res as unknown) as import("node:http").ServerResponse,
          f.auth,
          f.req,
          f.market,
          f.contracts,
          work,
          undefined,
          undefined,
          undefined,
          undefined,
          files
        );
      }
    );
  }
  async function upload(milestoneId: string, content: string) {
    const bytes = zip(content);
    const response = await request(f.seller, "/api/files", bytes, {
      kind: "artifact",
      resourceId: id,
      version: 1,
      revision: 0,
      milestoneId,
      name: "same.zip",
      mime: "application/zip",
      requestKey: randomUUID()
    });
    assert.equal(response.status, 200, response.bytes.toString());
    const download = await request(
      f.buyer,
      `/api/files/${response.data.id}/download`
    );
    assert.deepEqual(download.bytes, bytes);
    assert.equal(
      response.data.checksum,
      createHash("sha256")
        .update(bytes)
        .digest("hex")
    );
    return response.data.id as string;
  }
  async function command(extra: Record<string, unknown>) {
    const c = (await request(f.buyer, `/api/contracts/${id}`)).data;
    return request(f.buyer, `/api/contracts/${id}/commands`, {
      action: "milestone",
      version: c.version,
      revision: c.revision,
      confirmed: true,
      requestKey: randomUUID(),
      reason: { code: "manual", detail: "人工核对 ZIP" },
      ...extra
    });
  }
  try {
    for (const [index, milestone] of f.current().milestones.entries()) {
      const milestoneId = String(milestone.id),
        fileId = await upload(milestoneId, "first");
      const submit = (file: string) =>
        request(f.seller, `/api/workspaces/${id}/commands`, {
          action: "submit_milestone",
          version: 1,
          requestKey: randomUUID(),
          milestoneId,
          fileId: file,
          summary: "说明",
          instructions: "阅读",
          knownIssues: "无"
        });
      const competing = await Promise.all([submit(fileId), submit(fileId)]);
      assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
      if (index === 0) {
        assert.equal(
          (
            await command({
              milestoneId,
              to: "changes_requested",
              deliveryId: deliveryId(f.db, milestoneId)
            })
          ).status,
          200
        );
        const revised = await upload(milestoneId, "revised");
        assert.notEqual(revised, fileId);
        assert.equal((await submit(revised)).status, 200);
        assert.deepEqual(
          (await request(f.buyer, `/api/files/${fileId}/download`)).bytes,
          zip("first")
        );
      }
      assert.equal(
        (
          await command({
            milestoneId,
            to: "accepted",
            deliveryId: deliveryId(f.db, milestoneId)
          })
        ).status,
        200
      );
    }
    assert.equal(
      (await command({ action: "transition", to: "completed" })).data.status,
      "completed"
    );
    const first = f.contracts.read(f.buyer, id).zipDeliveries[0]!;
    assert.equal(
      (await request(f.second, `/api/files/${first.file_id}/download`)).status,
      403
    );
  } finally {
    f.db.close();
  }
});
