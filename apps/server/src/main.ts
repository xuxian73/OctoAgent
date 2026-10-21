import { Login } from "./login.js";
import { MarketplaceMcp } from "../../../packages/mcp/src/index.js";
import { mcpRoute } from "./mcp.js";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../../packages/database/src/index.js";
import { Authorization } from "../../../packages/auth/src/index.js";
import { createServer } from "node:http";
import { handleRequest } from "./app.js";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const database = openDatabase(
  process.env.DATABASE_URL || "file:./.data/octoagent.sqlite"
);
const authorization = new Authorization(database.identities);
const login = new Login(database.accounts, authorization);
const mcp = new MarketplaceMcp({
  auth: authorization,
  requirements: database.requirements(authorization),
  market: database.market(authorization),
  contracts: database.contracts(authorization),
  workspaces: database.workspaces(authorization),
  requests: database.mcpRequests()
});
const server = createServer((request, response) => {
  if (new URL(request.url || "/", "http://localhost").pathname === "/mcp") {
    void mcpRoute(request, response, randomUUID(), mcp);
    return;
  }
  handleRequest(
    request,
    response,
    authorization,
    database.requirements(authorization),
    database.market(authorization),
    database.contracts(authorization),
    database.workspaces(authorization),
    login,
    database.onboarding(authorization),
    database.agents(authorization)
  );
});
server.on("close", () => database.close());
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`OctoAgent listening on port ${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
