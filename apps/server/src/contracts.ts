import { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  ForbiddenError
} from "../../../packages/auth/src/index.js";
import {
  Contracts,
  contractBodyLimit
} from "../../../packages/database/src/contracts.js";
import { RequirementError } from "../../../packages/requirements/src/model.js";
export async function contractRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  service?: Contracts
) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (!service) throw new ForbiddenError();
    const path = new URL(request.url || "/", "http://localhost").pathname.split(
      "/"
    );
    const id = path[3] || "";
    const action = path[4];
    const method = request.method;
    const token = bearerToken(request);
    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PUT") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json")
        throw new RequirementError("JSON_REQUIRED", 415);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > contractBodyLimit)
          throw new RequirementError("BODY_TOO_LARGE", 413);
        chunks.push(bytes);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new RequirementError("INVALID_JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new RequirementError("INVALID_JSON");
    }
    let data: unknown;
    if (method === "POST" && path.length === 4 && id === "select")
      data = service.select(token, String(body.bidId || ""), body.confirmed);
    else if (method === "GET" && path.length === 4)
      data = service.read(token, id);
    else if (method === "POST" && path.length === 5 && action === "commands")
      data = service.command(token, id, body);
    else throw new RequirementError("NOT_FOUND", 404);
    response.end(JSON.stringify({ ok: true, data, request_id: requestId }));
  } catch (error) {
    response.statusCode =
      error instanceof ForbiddenError
        ? 403
        : error instanceof RequirementError
        ? error.status
        : 500;
    response.end(
      JSON.stringify({
        ok: false,
        error: {
          code:
            error instanceof ForbiddenError
              ? "FORBIDDEN"
              : error instanceof RequirementError
              ? error.code
              : "INTERNAL_ERROR",
          message:
            error instanceof ForbiddenError
              ? "无权访问"
              : "操作未完成，请检查字段、权限或重新加载最新草稿。"
        },
        request_id: requestId
      })
    );
  }
}
