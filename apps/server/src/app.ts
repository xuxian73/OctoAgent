import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { ApiResult, Health } from "../../../packages/shared/src/index.js";

export function errorResponse(
  requestId: string,
  notFound = false
): ApiResult<never> {
  return {
    ok: false,
    error: notFound
      ? { code: "NOT_FOUND", message: "资源不存在" }
      : { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    request_id: requestId
  };
}

export function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  const requestId = randomUUID();
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/api/health") {
      const body: ApiResult<Health> = {
        ok: true,
        data: { status: "ok" },
        request_id: requestId
      };
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(body));
      return;
    }
    const assets: Record<string, [string, string]> = {
      "/": ["apps/web/index.html", "text/html; charset=utf-8"],
      "/app.js": ["dist/apps/web/src/main.js", "text/javascript; charset=utf-8"]
    };
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (request.method === "GET" && asset) {
      const body = readFileSync(asset[0]);
      response.setHeader("Content-Type", asset[1]);
      response.end(body);
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(errorResponse(requestId, true)));
  } catch {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(errorResponse(requestId)));
  }
}
