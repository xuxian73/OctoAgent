import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest, errorResponse } from "../apps/server/src/app.js";

function request(url: string, method = "GET") {
  let body = "";
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(value: string | Buffer) {
      body = value.toString();
    }
  };
  handleRequest(
    { url, method } as IncomingMessage,
    (response as unknown) as ServerResponse
  );
  return { body, headers, status: response.statusCode };
}

test("health route uses the shared response and request ID contract", () => {
  const result = request("/api/health");
  const body = JSON.parse(result.body);
  assert.equal(result.status, 200);
  assert.deepEqual(body.data, { status: "ok" });
  assert.equal(body.ok, true);
  assert.equal(body.request_id, result.headers.get("X-Request-Id"));
});

test("unknown paths and unsupported methods return generic JSON errors", () => {
  for (const result of [
    request("/missing"),
    request("/api/health", "POST"),
    request("/../../.env"),
    request("/toString")
  ]) {
    assert.equal(result.status, 404);
    assert.equal(JSON.parse(result.body).error.code, "NOT_FOUND");
  }
});

test("frontend entry and compiled browser module are served", () => {
  assert.match(request("/").body, /OctoAgent/);
  assert.match(request("/app.js").body, /\/api\/health/);
});

test("internal errors contain only a stable public message", () => {
  assert.deepEqual(errorResponse("test-request"), {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    request_id: "test-request"
  });
});
