import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../../../apps/server/src/app.js";
import { Services } from "../../mcp/src/index.js";

// Exercise the real HTTP dispatcher and parsers without opening a listening socket.
export function localRequest(
  s: Services,
  token: string,
  path: string,
  method = "GET",
  body?: unknown
) {
  return new Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>(resolve => {
    const request = Readable.from(
      body === undefined ? [] : [JSON.stringify(body)]
    ) as IncomingMessage;
    request.url = path;
    request.method = method;
    request.headers = { "content-type": "application/json" };
    request.rawHeaders = token ? ["Authorization", "Bearer " + token] : [];
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      end(text: string) {
        resolve({ status: response.statusCode, headers, text });
      }
    };
    handleRequest(
      request,
      (response as unknown) as ServerResponse,
      s.auth,
      s.requirements,
      s.market,
      s.contracts,
      s.workspaces
    );
  });
}
