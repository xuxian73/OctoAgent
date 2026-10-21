import { validateZip } from "./zip.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { ByteScanner } from "../../database/src/files.js";

let activeScans = 0;
const maxConcurrentScans = 2;

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
  async scan(
    bytes: Uint8Array,
    checksum: string
  ): Promise<"clean" | "rejected" | "unavailable"> {
    if (
      bytes.length > 10485760 ||
      createHash("sha256")
        .update(bytes)
        .digest("hex") !== checksum
    )
      return "unavailable";
    if (
      Buffer.from(bytes)
        .subarray(0, 2)
        .toString() === "PK"
    ) {
      try {
        validateZip(bytes);
      } catch {
        return "rejected";
      }
    }
    // Global admission limit: overload fails closed without an unbounded queue.
    if (activeScans >= maxConcurrentScans) return "unavailable";
    activeScans++;
    try {
      return await new Promise<"clean" | "rejected" | "unavailable">(
        resolve => {
          const child = spawn(
            this.executable,
            [
              "--no-summary",
              "--stdout",
              "--scan-archive=yes",
              "--max-recursion=4",
              "--max-files=1000",
              "--max-scantime=30000",
              "--alert-encrypted=yes",
              "--alert-exceeds-max=yes",
              "--max-filesize=10M",
              "--max-scansize=30M",
              "-"
            ],
            {
              stdio: ["pipe", "ignore", "ignore"],
              env: { PATH: "/usr/bin:/bin", LANG: "C" },
              windowsHide: true
            }
          );
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, this.timeout);
          child.stdin.on("error", () => {});
          child.on("error", () => {
            clearTimeout(timer);
            resolve("unavailable");
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve(
              timedOut || signal
                ? "unavailable"
                : code === 0
                ? "clean"
                : code === 1
                ? "rejected"
                : "unavailable"
            );
          });
          child.stdin.end(bytes);
        }
      );
    } catch {
      return "unavailable";
    } finally {
      activeScans--;
    }
  }
  private cachedHealth = { scanner: this.name, status: "unavailable" };
  private probe?: Promise<void>;
  health() {
    return { ...this.cachedHealth };
  }
  refreshHealth(): Promise<void> {
    if (this.probe) return this.probe;
    const bytes = Buffer.from("OctoAgent scanner health probe\n");
    this.probe = this.scan(
      bytes,
      createHash("sha256")
        .update(bytes)
        .digest("hex")
    )
      .then(result => {
        this.cachedHealth = {
          scanner: this.name,
          status: result === "clean" ? "available" : "unavailable"
        };
      })
      .finally(() => {
        this.probe = undefined;
      });
    return this.probe;
  }
}

// Public requests only read this cache; probes run independently of request traffic.
export const healthScanner = new ClamAVScanner();
void healthScanner.refreshHealth();
setInterval(() => {
  void healthScanner.refreshHealth();
}, 60000).unref();
