import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { ByteScanner } from "../../database/src/files.js";

/** Deployment configuration only. No shell, user arguments, paths or archive extraction. */
export class ClamAVScanner implements ByteScanner {
  readonly name = "clamav-clamscan";
  readonly simulated = false;
  constructor(
    private executable = process.env.CLAMAV_EXECUTABLE || "/usr/bin/clamscan",
    private timeout = Number(process.env.CLAMAV_TIMEOUT_MS || 30000)
  ) {
    if (
      !isAbsolute(executable) ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 60000
    )
      throw new Error("INVALID_SCANNER_CONFIGURATION");
  }
  scan(
    bytes: Uint8Array,
    checksum: string
  ): "clean" | "rejected" | "unavailable" {
    if (
      bytes.length > 10485760 ||
      createHash("sha256")
        .update(bytes)
        .digest("hex") !== checksum
    )
      return "unavailable";
    // Archives remain unverified: disabling unpacking must not certify their contents.
    if (
      Buffer.from(bytes)
        .subarray(0, 2)
        .toString() === "PK"
    )
      return "rejected";
    try {
      const result = spawnSync(
        this.executable,
        [
          "--no-summary",
          "--stdout",
          "--scan-archive=no",
          "--alert-exceeds-max=yes",
          "--max-filesize=10M",
          "--max-scansize=10M",
          "-"
        ],
        {
          input: bytes,
          timeout: this.timeout,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          windowsHide: true
        }
      );
      // Never expose output: it can contain private content, host paths or signatures.
      if (result.error || result.signal) return "unavailable";
      return result.status === 0
        ? "clean"
        : result.status === 1
        ? "rejected"
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  health() {
    const bytes = Buffer.from("OctoAgent scanner health probe\n");
    return {
      scanner: this.name,
      status:
        this.scan(
          bytes,
          createHash("sha256")
            .update(bytes)
            .digest("hex")
        ) === "clean"
          ? "available"
          : "unavailable"
    };
  }
}
