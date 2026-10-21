import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { Audit } from "./security.js";
import { requestContext, securityContext } from "../../security/src/index.js";
import { DatabaseSync } from "node:sqlite";
// Fixed, versioned by this schema: scrypt N=32768, r=8, p=1, 64-byte output.
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key))
    )
  );
}
export class LocalAccounts {
  constructor(private readonly db: DatabaseSync) {}
  auditLogin(requestId: string, result: "success" | "denied" | "limited") {
    securityContext.run(requestContext(requestId), () =>
      new Audit(this.db).append("auth.login", result)
    );
  }
  async create(
    username: string,
    userId: string,
    password: string
  ): Promise<void> {
    if (
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(username) ||
      password.length < 12 ||
      password.length > 256
    )
      throw new Error("Invalid account input");
    const salt = randomBytes(32).toString("hex");
    const hash = (await derive(password, salt)) as Buffer;
    this.db.exec("SAVEPOINT local_account");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO users (id) VALUES (?)")
        .run(userId);
      this.db
        .prepare("INSERT INTO local_accounts VALUES (?, ?, ?, ?)")
        .run(username, userId, salt, hash.toString("hex"));
      this.db.exec("RELEASE local_account");
    } catch (error) {
      this.db.exec("ROLLBACK TO local_account; RELEASE local_account");
      throw error;
    }
  }
  async verify(
    username: unknown,
    password: unknown
  ): Promise<string | undefined> {
    const valid =
      typeof username === "string" &&
      /^[a-zA-Z0-9_.-]{1,64}$/.test(username) &&
      typeof password === "string" &&
      password.length <= 256;
    const row = valid
      ? this.db
          .prepare("SELECT * FROM local_accounts WHERE username = ?")
          .get(username)
      : undefined;
    // Unknown accounts perform the same expensive derivation.
    const hash = (await derive(
      valid ? (password as string) : "",
      row ? String(row.salt) : "unknown-account"
    )) as Buffer;
    const expected = row
      ? Buffer.from(String(row.password_hash), "hex")
      : Buffer.alloc(64);
    return timingSafeEqual(hash, expected) && row
      ? String(row.user_id)
      : undefined;
  }
}
