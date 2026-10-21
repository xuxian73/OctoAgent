import { IncomingMessage, ServerResponse } from "node:http";
import {
  Authorization,
  csrfToken,
  SESSION_COOKIE,
  sessionCookie,
  tokenDigest,
  webToken
} from "../../../packages/auth/src/index.js";
import { LocalAccounts } from "../../../packages/database/src/accounts.js";

export class Login {
  private attempts = new Map<string, { count: number; until: number }>();
  private active = 0;
  constructor(
    private readonly accounts: LocalAccounts,
    private readonly auth: Authorization,
    private readonly now: () => number = Date.now,
    private readonly production = process.env.NODE_ENV === "production"
  ) {}
  private cookie(value: string, clear = false) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${
      clear ? "; Max-Age=0" : ""
    }${this.production ? "; Secure" : ""}`;
  }
  async route(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    let audited = false;
    const send = (status: number, data?: unknown) => {
      if (
        !audited &&
        new URL(request.url || "/", "http://localhost").pathname ===
          "/api/auth/login"
      ) {
        audited = true;
        this.accounts.auditLogin(
          requestId,
          status === 200 ? "success" : status === 429 ? "limited" : "denied"
        );
      }
      response.statusCode = status;
      response.end(
        JSON.stringify(
          status === 200
            ? { ok: true, data, request_id: requestId }
            : {
                ok: false,
                error: { code: "AUTH_FAILED", message: "登录或会话验证失败" },
                request_id: requestId
              }
        )
      );
    };
    try {
      const path = new URL(request.url || "/", "http://localhost").pathname;
      if (path === "/api/auth/login" && request.method === "POST") {
        // JSON plus a custom header prevents cross-origin form/login CSRF. No CORS is enabled.
        if (
          request.headers["content-type"] !== "application/json" ||
          request.headers["x-octo-login"] !== "1" ||
          request.headers["sec-fetch-site"] === "cross-site"
        )
          return send(403);
        if (
          (request.rawHeaders || []).some(
            (v, i) => i % 2 === 0 && v.toLowerCase() === "authorization"
          )
        )
          return send(403);
        sessionCookie(request); // reject duplicate session cookies
        const now = this.now();
        for (const [key, entry] of this.attempts)
          if (entry.until <= now) this.attempts.delete(key);
        // Socket address only: untrusted forwarded headers cannot bypass limits.
        const key = request.socket.remoteAddress || "unknown";
        const entry = this.attempts.get(key) || {
          count: 0,
          until: now + 60_000
        };
        if (
          entry.count >= 5 ||
          this.active >= 4 ||
          (!this.attempts.has(key) && this.attempts.size >= 1024)
        )
          return send(429);
        entry.count++;
        this.attempts.set(key, entry);
        this.active++;
        try {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 4096) return send(401);
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const user = await this.accounts.verify(
            body?.username,
            body?.password
          );
          if (!user) return send(401);
          const token = this.auth.issueUserSession(user);
          response.setHeader("Set-Cookie", this.cookie(token));
          return send(200, {
            identity: this.auth.identity(token),
            csrf: csrfToken(token)
          });
        } finally {
          this.active--;
        }
      }
      const token = webToken(request);
      if (
        sessionCookie(request) === undefined ||
        this.auth.identity(token).kind !== "user"
      )
        return send(401);
      if (path === "/api/auth/me" && request.method === "GET")
        return send(200, {
          identity: this.auth.identity(token),
          csrf: csrfToken(token)
        });
      if (path === "/api/auth/logout" && request.method === "POST") {
        this.auth.revoke(token, tokenDigest(token));
        response.setHeader("Set-Cookie", this.cookie("", true));
        return send(200, {});
      }
      send(404);
    } catch {
      send(401);
    }
  }
}
