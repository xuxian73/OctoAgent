import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ClamAVScanner } from "../packages/security/src/clamav.js";

test("offline process fixture verifies actual stdin, fixed options, exits, missing dependency and timeout", () => {
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
    assert.equal(scanner.scan(bytes, checksum), "clean");
    assert.equal(scanner.scan(bytes, "wrong"), "unavailable");
    const archive = Buffer.from("PK\x03\x04archive");
    assert.equal(
      scanner.scan(
        archive,
        createHash("sha256")
          .update(archive)
          .digest("hex")
      ),
      "rejected"
    );
    script("exit 1\n");
    assert.equal(scanner.scan(bytes, checksum), "rejected");
    script("exit 2\n");
    assert.equal(scanner.scan(bytes, checksum), "unavailable");
    script("while :; do :; done\n");
    assert.equal(
      new ClamAVScanner(executable, 20).scan(bytes, checksum),
      "unavailable"
    );
    assert.equal(
      new ClamAVScanner(join(dir, "missing")).scan(bytes, checksum),
      "unavailable"
    );
    assert.throws(() => new ClamAVScanner("user-command"), /CONFIGURATION/);
    assert.throws(() => new ClamAVScanner(executable, 60001), /CONFIGURATION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
