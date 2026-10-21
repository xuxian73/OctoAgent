import {
  securityContext,
  requestContext
} from "../../../packages/security/src/index.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Files, FileUpload } from "../../../packages/database/src/files.js";
import { webToken, ForbiddenError } from "../../../packages/auth/src/index.js";
import { RequirementError } from "../../../packages/requirements/src/model.js";
async function executeRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  files?: Files
) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (!files) throw new ForbiddenError();
    const token = webToken(request);
    const url = new URL(request.url!, "http://localhost");
    const parts = url.pathname.split("/");
    let data: unknown;
    if (request.method === "POST" && parts.length === 3) {
      const raw = request.headers["x-file-metadata"];
      if (typeof raw !== "string" || raw.length > 8000)
        throw new RequirementError("FILE_METADATA_REQUIRED");
      let input: FileUpload;
      try {
        input = JSON.parse(decodeURIComponent(raw));
      } catch {
        throw new RequirementError("INVALID_FILE_METADATA");
      }
      if (!input || typeof input !== "object")
        throw new RequirementError("INVALID_FILE_METADATA");
      if (request.headers["content-type"] !== "application/octet-stream")
        throw new RequirementError("BINARY_REQUIRED", 415);
      // Authorize before buffering, then recheck within the upload transaction.
      files.list(token, input.kind, input.resourceId);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > files.limits.maxBytes)
          throw new RequirementError("FILE_SIZE_LIMIT", 413);
        chunks.push(bytes);
      }
      const stored = files.upload(token, input, Buffer.concat(chunks));
      if (stored.scan_status === "quarantined")
        await files.scan(String(stored.id), String(stored.actor));
      data = files.metadata(token, String(stored.id));
    } else if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[4] === "scan"
    ) {
      data = await files.retry(token, parts[3]!);
    } else if (request.method === "GET" && parts.length === 3) {
      data = files.list(
        token,
        url.searchParams.get("kind") as FileUpload["kind"],
        url.searchParams.get("resourceId") || ""
      );
    } else if (request.method === "GET" && parts.length === 4) {
      data = files.metadata(token, parts[3]!);
    } else if (
      request.method === "GET" &&
      parts.length === 5 &&
      parts[4] === "download"
    ) {
      const { metadata, bytes } = files.download(token, parts[3]!);
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", bytes.length);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(
          String(metadata.name)
        ).replace(/'/g, "%27")}`
      );
      response.end(bytes);
      return;
    } else throw new RequirementError("NOT_FOUND", 404);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true, data, request_id: requestId }));
  } catch (error) {
    response.statusCode =
      error instanceof ForbiddenError
        ? 403
        : error instanceof RequirementError
        ? error.status
        : 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        ok: false,
        error: {
          code:
            error instanceof RequirementError
              ? error.code
              : error instanceof ForbiddenError
              ? "FORBIDDEN"
              : "INTERNAL_ERROR",
          message: "文件操作失败或被阻止"
        },
        request_id: requestId
      })
    );
  }
}

export function fileRoute(...args: Parameters<typeof executeRoute>) {
  return securityContext.run(requestContext(args[2]), () =>
    executeRoute(...args)
  );
}
