import { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ClamAVScanner } from "../packages/security/src/clamav.js";

test("offline process fixture verifies actual stdin, fixed options, exits, missing dependency and timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "octo-clam-fixture-"));
  try {
    const source = join(dir, "sample");
    writeFileSync(source, "actual bytes\n");
    const bytes = readFileSync(source);
    const checksum = createHash("sha256")
      .update(bytes)
      .digest("hex");
    const executable = join(dir, "scanner");
    const script = (body: string) =>
      writeFileSync(executable, "#!/bin/sh\n" + body, { mode: 0o700 });
    script(
      '[ "$1" = "--no-summary" ] || exit 2\n[ "$3" = "--scan-archive=no" ] || exit 2\n[ "$(cat)" = "actual bytes" ] || exit 2\nexit 0\n'
    );
    const scanner = new ClamAVScanner(executable, 1000);
    assert.equal(await scanner.scan(bytes, checksum), "clean");
    assert.equal(await scanner.scan(bytes, "wrong"), "unavailable");
    const archive = Buffer.from("PK\x03\x04archive");
    assert.equal(
      await scanner.scan(
        archive,
        createHash("sha256")
          .update(archive)
          .digest("hex")
      ),
      "rejected"
    );
    script("exit 1\n");
    assert.equal(await scanner.scan(bytes, checksum), "rejected");
    script("exit 2\n");
    assert.equal(await scanner.scan(bytes, checksum), "unavailable");
    script("while :; do :; done\n");
    assert.equal(
      await new ClamAVScanner(executable, 20).scan(bytes, checksum),
      "unavailable"
    );
    assert.equal(
      await new ClamAVScanner(join(dir, "missing")).scan(bytes, checksum),
      "unavailable"
    );
    assert.throws(() => new ClamAVScanner("user-command"), /CONFIGURATION/);
    assert.throws(() => new ClamAVScanner(executable, 60001), /CONFIGURATION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slow process leaves HTTP responsive, bounds concurrency and coalesces cached health probes", async () => {
  const { handleRequest } = await import("../apps/server/src/app.js");
  const dir = mkdtempSync(join(tmpdir(), "octo-slow-scan-"));
  const executable = join(dir, "scanner");
  writeFileSync(executable, "#!/bin/sh\ncat >/dev/null\nsleep 1\nexit 0\n", {
    mode: 0o700
  });
  const scanner = new ClamAVScanner(executable, 3000);
  try {
    const probe = scanner.refreshHealth();
    assert.equal(scanner.refreshHealth(), probe);
    assert.equal(scanner.health().status, "unavailable");
    const bytes = Buffer.from("slow scan");
    const checksum = createHash("sha256")
      .update(bytes)
      .digest("hex");
    const scan = scanner.scan(bytes, checksum);
    assert.equal(await scanner.scan(bytes, checksum), "unavailable");
    let finished = false;
    void probe.then(() => {
      finished = true;
    });
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      let body = "";
      const response = {
        statusCode: 200,
        setHeader() {},
        end(value: string) {
          body = value;
        }
      };
      handleRequest(
        { method: "GET", url: "/api/health", headers: {} } as IncomingMessage,
        (response as unknown) as ServerResponse
      );
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(body).ok, true);
    }
    assert.equal(
      finished,
      false,
      "HTTP responses arrive while scanner is still running"
    );
    assert.equal(scanner.refreshHealth(), probe);
    await probe;
    assert.equal(await scan, "clean");
    assert.equal(scanner.health().status, "available");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
