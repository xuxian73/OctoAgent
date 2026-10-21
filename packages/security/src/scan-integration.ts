import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClamAVScanner } from "./clamav.js";
const scanner = new ClamAVScanner();
let executableAvailable = false;
try {
  accessSync(
    process.env.CLAMAV_EXECUTABLE || "/usr/bin/clamscan",
    constants.X_OK
  );
  executableAvailable = true;
} catch {
  /* Only report presence, never host paths. */
}
console.log(
  JSON.stringify({
    scanner: scanner.name,
    executableAvailable,
    signatureDatabase: "validated by actual scan below"
  })
);
const directory = mkdtempSync(join(tmpdir(), "octo-scan-integration-"));
try {
  const cases = [
    ["clean", "OctoAgent clean integration sample\n", "clean"],
    [
      "eicar",
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
      "rejected"
    ]
  ];
  let verified = true;
  for (const [name, content, expected] of cases) {
    const path = join(directory, name!);
    writeFileSync(path, content!, { mode: 0o600 });
    const bytes = readFileSync(path);
    const actual = await scanner.scan(
      bytes,
      createHash("sha256")
        .update(bytes)
        .digest("hex")
    );
    console.log(
      JSON.stringify({
        scanner: scanner.name,
        sample: name,
        expected,
        actual,
        verified: actual === expected
      })
    );
    verified = verified && actual === expected;
  }
  console.log(
    verified
      ? "真实 ClamAV 联调通过"
      : "未验证：检查 ClamAV 可执行文件、病毒库、权限及超时配置"
  );
  if (!verified) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
