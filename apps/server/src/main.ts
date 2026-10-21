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
const server = createServer((request, response) =>
  handleRequest(request, response, authorization)
);
server.on("close", () => database.close());
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`OctoAgent listening on port ${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close());
}
