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
    end(value: string | Buffer = "") {
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
  assert.equal(body.data.status, "ok");
  assert.equal(body.data.fileScanner.scanner, "clamav-clamscan");
  assert.ok(
    ["available", "unavailable"].includes(body.data.fileScanner.status)
  );
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
  assert.match(request("/app.js").body, /mountInteractions/);
});

test("internal errors contain only a stable public message", () => {
  assert.deepEqual(errorResponse("test-request"), {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    request_id: "test-request"
  });
});

test("console is anonymous and preview contains only synthetic context", () => {
  const anonymous = request("/console/contracts?state=empty");
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.body, /请先登录/);
  assert.doesNotMatch(anonymous.body, /Agent 动作摘要|aria-label="主导航"/);
  const preview = request("/preview/contracts");
  assert.equal(preview.status, 200);
  assert.match(preview.body, /演示模式/);
  assert.match(preview.body, /aria-current="page">合同/);
  assert.equal(preview.headers.get("Cache-Control"), "no-store");
  assert.equal(request("/preview/missing").status, 404);
  assert.equal(request("/preview?state=forbidden").status, 403);
  assert.match(request("/preview?state=failed").body, /加载失败/);
  assert.match(request("/preview?state=loading").body, /aria-busy="true"/);
  assert.match(request("/preview?state=unknown").body, /尚无交付记录/);
});

test("styles are served and contract API requires authorization", () => {
  for (const asset of ["/tokens.css", "/app.css"]) {
    assert.equal(
      request(asset).headers.get("Content-Type"),
      "text/css; charset=utf-8"
    );
  }
  assert.equal(request("/preview/requirements", "POST").status, 404);
  assert.equal(request("/api/contracts").status, 403);
});

test("requirement editor and its browser dependency are explicitly served", () => {
  assert.equal(
    request("/requirements").headers.get("Location"),
    "/login?expired=1"
  );
  assert.match(request("/requirements.js").body, /mountRequirementEditor/);
  assert.match(
    request("/packages/requirements/src/model.js").body,
    /taskTypes/
  );
  assert.equal(request("/api/requirements-other").status, 404);
});

test("contract console and browser module are explicitly served", () => {
  assert.equal(request("/contracts").status, 303);
  assert.match(request("/contracts.js").body, /mountContracts/);
  assert.equal(request("/api/contracts-other").status, 404);
});
