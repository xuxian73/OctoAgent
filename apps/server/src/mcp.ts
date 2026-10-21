import { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  bearerToken,
  ForbiddenError
} from "../../../packages/auth/src/index.js";
import { MarketplaceMcp } from "../../../packages/mcp/src/index.js";

export async function mcpRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  service: MarketplaceMcp
) {
  response.setHeader("Cache-Control", "no-store");
  let server: ReturnType<MarketplaceMcp["server"]> | undefined;
  try {
    // No cookie-based identity. Reject browser origins: deployments can explicitly
    // allow a trusted origin at their authenticating reverse proxy instead.
    if (request.headers.origin) throw new ForbiddenError();
    const token = bearerToken(request);
    server = service.server(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message: "无权访问",
            data: {
              request_id: requestId,
              status: "error",
              next_step: "请责任主体检查授权",
              summary: "无权访问",
              requires_human_confirmation: false
            }
          }
        })
      );
    }
  } finally {
    await server?.close();
  }
}
