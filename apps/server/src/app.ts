import { Files } from "../../../packages/database/src/files.js";
import { fileRoute } from "./files.js";
import { Agents } from "../../../packages/database/src/agents.js";
import { agentRoute } from "./agents.js";
import { renderAgents } from "../../web/src/agents.js";
import { Disputes } from "../../../packages/database/src/disputes.js";
import { disputeRoute } from "./disputes.js";
import {
  renderApplication,
  emptyApplication,
  businessPages,
  ApplicationProject
} from "../../web/src/application.js";
import { Onboarding } from "../../../packages/database/src/onboarding.js";
import { onboardingRoute } from "./onboarding.js";
import { renderOnboarding } from "../../web/src/onboarding.js";
import { Login } from "./login.js";
import { sessionCookie, webToken } from "../../../packages/auth/src/index.js";
import { renderRegister } from "../../web/src/register.js";
import { renderLogin } from "../../web/src/session.js";
import { Workspaces } from "../../../packages/database/src/workspaces.js";
import { workspaceRoute } from "./workspaces.js";
import { renderWorkspaces } from "../../web/src/workspaces.js";
import { Contracts } from "../../../packages/database/src/contracts.js";
import { contractRoute } from "./contracts.js";
import { renderContracts } from "../../web/src/contracts.js";
import { Market } from "../../../packages/database/src/market.js";
import { marketRoute } from "./market.js";
import { renderMarket } from "../../web/src/market.js";
import { Requirements } from "../../../packages/database/src/requirements.js";
import { requirementRoute } from "./requirements.js";
import { renderRequirementEditor } from "../../web/src/requirements.js";
import {
  Authorization,
  authorizeRequest,
  ForbiddenError,
  resourceKinds,
  ResourceKind
} from "../../../packages/auth/src/index.js";
import { renderConsole, pages, ViewState } from "../../web/src/shell.js";
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
  response: ServerResponse,
  authorization?: Authorization,
  requirements?: Requirements,
  market?: Market,
  contracts?: Contracts,
  workspaces?: Workspaces,
  login?: Login,
  onboarding?: Onboarding,
  disputes?: Disputes,
  agents?: Agents,
  files?: Files
): void {
  const requestId = randomUUID();
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (path.startsWith("/api/auth/")) {
      if (!login) throw new ForbiddenError();
      void login.route(request, response, requestId);
      return;
    }
    if (path === "/register" && request.method === "GET") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(renderRegister());
      return;
    }
    if (path === "/login" && request.method === "GET") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        renderLogin(
          new URL(request.url!, "http://localhost").searchParams.has("expired")
        )
      );
      return;
    }
    if (
      path === "/api/onboarding" ||
      path === "/api/onboarding/seller" ||
      path === "/api/contexts"
    ) {
      void onboardingRoute(request, response, requestId, onboarding);
      return;
    }
    if (
      path.startsWith("/api/") &&
      sessionCookie(request) !== undefined &&
      (!authorization ||
        authorization.identity(webToken(request)).kind !== "user")
    )
      throw new ForbiddenError();
    if (path === "/api/agents" || path.startsWith("/api/agents/")) {
      void agentRoute(request, response, requestId, agents);
      return;
    }
    if (path === "/api/files" || path.startsWith("/api/files/")) {
      void fileRoute(request, response, requestId, files);
      return;
    }
    const page = path.slice(1);
    if (
      request.method === "GET" &&
      (Object.hasOwn(businessPages, page) ||
        path === "/" ||
        path === "/console" ||
        path.startsWith("/console/") ||
        path === "/onboarding" ||
        path === "/agents")
    ) {
      try {
        if (
          !authorization ||
          authorization.identity(webToken(request)).kind !== "user"
        )
          throw new ForbiddenError();
      } catch {
        response.statusCode = 303;
        response.setHeader("Location", "/login?expired=1");
        response.end("请先登录 OctoAgent");
        return;
      }
      const context = onboarding?.list(webToken(request));
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (path === "/onboarding") {
        response.end(
          renderApplication(
            renderOnboarding(context?.sellerProfile),
            "onboarding",
            []
          )
        );
        return;
      }
      if (path === "/agents") {
        response.end(renderApplication(renderAgents(), "agents", []));
        return;
      }
      if (
        context?.sellerProfile &&
        !new URL(request.url!, "http://localhost").searchParams.has(
          "project"
        ) &&
        (path === "/market" ||
          ((path === "/" || path === "/console") && !context.projects.length))
      ) {
        response.end(
          renderApplication(
            emptyApplication("可接任务").replace(
              "</main>",
              '<p>乙方资料已完成。公开任务检索将在后续开放；当前暂无可接任务。</p><a href="/onboarding#seller">编辑乙方资料</a><a href="/onboarding#buyer">发布需求：创建首个项目</a></main>'
            ),
            "market",
            (context.projects as unknown) as ApplicationProject[]
          )
        );
        return;
      }
      if (context?.canInitialize && !context.sellerProfile) {
        response.statusCode = 303;
        response.setHeader("Location", "/onboarding");
        response.end();
        return;
      }
      const projects = ((context?.projects ||
        []) as unknown) as ApplicationProject[];
      const requested = new URL(
        request.url!,
        "http://localhost"
      ).searchParams.get("project");
      const selected = requested
        ? projects.find(p => p.id === requested)
        : projects[0];
      const destination = Object.hasOwn(businessPages, page)
        ? page
        : selected?.pages[0];
      const renderers: Record<string, () => string> = {
        requirements: renderRequirementEditor,
        market: renderMarket,
        contracts: renderContracts,
        workspaces: renderWorkspaces
      };
      const allowed = destination && selected?.pages.includes(destination);
      if (!allowed) response.statusCode = 403;
      response.end(
        renderApplication(
          allowed
            ? renderers[destination!]!()
            : emptyApplication(
                "暂无获准访问的内容，请选择授权项目或联系组织负责人。"
              ),
          destination || "",
          projects,
          selected
        )
      );
      return;
    }
    if (path === "/api/disputes" || path.startsWith("/api/disputes/")) {
      void disputeRoute(request, response, requestId, disputes);
      return;
    }
    if (request.method === "GET" && /^\/disputes\/[^/]+$/.test(path)) {
      if (!disputes) throw new ForbiddenError();
      const view = disputes.read(webToken(request), path.split("/")[2]!);
      const entities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };
      const escape = (value: unknown) =>
        String(value).replace(/[&<>"']/g, char => entities[char]!);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>争议案件</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"><main><h1>争议案件（只读）</h1><p>案件 ${escape(
          view.id
        )} · 合同保持冻结</p><h2>脱敏审计</h2><ul>${view.audit
          .map(
            e =>
              `<li>${escape(e.created_at)} · ${escape(e.event)} · ${escape(
                e.result
              )}</li>`
          )
          .join("") ||
          "<li>暂无审计</li>"}</ul><h2>双方明确提交的证据引用</h2><p>引用不授予源内容或私有仓库访问权限。</p><ul>${view.evidence
          .map(
            e =>
              `<li>${
                e.party === "buyer" ? "甲方" : "乙方"
              } · 合同事件 #${escape(e.event_sequence)} · ${escape(e.id)}</li>`
          )
          .join("") || "<li>暂无提交证据</li>"}</ul></main></html>`
      );
      return;
    }
    if (path === "/api/workspaces" || path.startsWith("/api/workspaces/")) {
      void workspaceRoute(request, response, requestId, workspaces);
      return;
    }

    if (path === "/api/contracts" || path.startsWith("/api/contracts/")) {
      void contractRoute(request, response, requestId, contracts);
      return;
    }

    if (path === "/api/market" || path.startsWith("/api/market/")) {
      void marketRoute(request, response, requestId, market);
      return;
    }

    if (path === "/api/requirements" || path.startsWith("/api/requirements/")) {
      void requirementRoute(request, response, requestId, requirements);
      return;
    }

    // Read-only authorization metadata, not contract/workspace business data.
    if (path.startsWith("/api/access/")) {
      response.setHeader("Cache-Control", "no-store");
      const parts = path.split("/");
      const kind = parts[3] as ResourceKind;
      const id = parts[4];
      if (
        !authorization ||
        request.method !== "GET" ||
        parts.length !== 5 ||
        !resourceKinds.includes(kind) ||
        !id
      )
        throw new ForbiddenError();
      const access = authorizeRequest(authorization, request, {
        kind,
        resourceId: id,
        action: "read"
      });
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({ ok: true, data: access, request_id: requestId })
      );
      return;
    }
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
    if (
      request.method === "GET" &&
      (path === "/" ||
        path === "/console" ||
        path.startsWith("/console/") ||
        path === "/preview" ||
        path.startsWith("/preview/"))
    ) {
      const preview = path === "/preview" || path.startsWith("/preview/");
      const page = path.split("/")[2] || "home";
      const requestedState = new URL(
        request.url || "/",
        "http://localhost"
      ).searchParams.get("state");
      const states: readonly string[] = [
        "empty",
        "loading",
        "failed",
        "forbidden",
        "not-found",
        "form-error"
      ];
      const state =
        preview && requestedState && states.includes(requestedState)
          ? (requestedState as ViewState)
          : undefined;
      // Public synthetic preview only. Never derive a real session from URL input.
      const session = preview
        ? {
            organization: "演示组织",
            permissions: Object.values(pages).map(page => page.permission)
          }
        : null;
      response.statusCode = !preview
        ? 401
        : !Object.hasOwn(pages, page) || state === "not-found"
        ? 404
        : state === "forbidden"
        ? 403
        : 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(renderConsole({ session, page, preview, state }));
      return;
    }
    const assets: Record<string, [string, string]> = {
      "/register.js": [
        "dist/apps/web/src/register.js",
        "text/javascript; charset=utf-8"
      ],
      "/packages/shared/src/accounts.js": [
        "dist/packages/shared/src/accounts.js",
        "text/javascript; charset=utf-8"
      ],
      "/agents.js": [
        "dist/apps/web/src/agents.js",
        "text/javascript; charset=utf-8"
      ],
      "/client.js": [
        "dist/apps/web/src/client.js",
        "text/javascript; charset=utf-8"
      ],
      "/onboarding.js": [
        "dist/apps/web/src/onboarding.js",
        "text/javascript; charset=utf-8"
      ],
      "/session.js": [
        "dist/apps/web/src/session.js",
        "text/javascript; charset=utf-8"
      ],
      "/workspaces.js": [
        "dist/apps/web/src/workspaces.js",
        "text/javascript; charset=utf-8"
      ],
      "/contracts.js": [
        "dist/apps/web/src/contracts.js",
        "text/javascript; charset=utf-8"
      ],
      "/market.js": [
        "dist/apps/web/src/market.js",
        "text/javascript; charset=utf-8"
      ],
      "/packages/requirements/src/bids.js": [
        "dist/packages/requirements/src/bids.js",
        "text/javascript; charset=utf-8"
      ],
      "/requirements.js": [
        "dist/apps/web/src/requirements.js",
        "text/javascript; charset=utf-8"
      ],
      "/packages/requirements/src/model.js": [
        "dist/packages/requirements/src/model.js",
        "text/javascript; charset=utf-8"
      ],
      "/files.js": [
        "dist/apps/web/src/files.js",
        "text/javascript; charset=utf-8"
      ],
      "/tokens.css": ["apps/web/tokens.css", "text/css; charset=utf-8"],
      "/app.css": ["apps/web/app.css", "text/css; charset=utf-8"],
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
  } catch (error) {
    if (error instanceof ForbiddenError) {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: "FORBIDDEN", message: "无权访问" },
          request_id: requestId
        })
      );
      return;
    }
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(errorResponse(requestId)));
  }
}
