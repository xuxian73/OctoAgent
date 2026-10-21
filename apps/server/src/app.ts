import { Agents } from "../../../packages/database/src/agents.js";
import { agentRoute } from "./agents.js";
import { renderAgents } from "../../web/src/agents.js";
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
  agents?: Agents
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
    if (path === "/login" && request.method === "GET") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        renderLogin(
          new URL(request.url!, "http://localhost").searchParams.has("expired")
        )
      );
      return;
    }
    if (path === "/api/onboarding" || path === "/api/contexts") {
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
        response.end(renderOnboarding());
        return;
      }
      if (path === "/agents") {
        response.end(renderApplication(renderAgents(), "agents", []));
        return;
      }
      if (context?.canInitialize) {
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
