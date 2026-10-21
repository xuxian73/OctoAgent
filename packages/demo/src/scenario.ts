import { FakeGitHubProvider } from "../../delivery/src/github.js";
import { FakeScanner } from "../../security/src/index.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Authorization, Scope, tokenDigest } from "../../auth/src/index.js";
import { SqliteIdentityStore } from "../../database/src/identity.js";
import { Onboarding } from "../../database/src/onboarding.js";
import { Requirements } from "../../database/src/requirements.js";
import { Market } from "../../database/src/market.js";
import { Contracts } from "../../database/src/contracts.js";
import { Workspaces } from "../../database/src/workspaces.js";
import { McpRequests } from "../../database/src/mcp.js";
import { MarketplaceMcp } from "../../mcp/src/index.js";
import { outputSchema, Envelope } from "../../mcp/src/schemas.js";
import { checksum } from "../../delivery/src/github.js";
import { draft, proposal, seedSubjects } from "./data.js";
import { localRequest } from "./transport.js";

type Contract = ReturnType<Contracts["read"]>;
type Task = ReturnType<Requirements["read"]>;
type Bid = ReturnType<Market["draft"]>;
export interface Step {
  action: string;
  request_id: string;
  result: string;
  audit: { sequence: number; event: string; result: string }[];
}
export interface Report {
  mode: "offline-fake";
  tasks: string[];
  contracts: string[];
  outcomes: string[];
  steps: Step[];
}

// The clock advances explicitly for expiration checks; no sleeps or network.
// Human calls below simulate the named responsible person's explicit approval.
export async function runScenario(db: DatabaseSync): Promise<Report> {
  seedSubjects(db);
  let now = 1000;
  const auth = new Authorization(new SqliteIdentityStore(db), () => now);
  const services = {
    auth,
    onboarding: new Onboarding(db, auth),
    requirements: new Requirements(db, auth, () => now, new FakeScanner()),
    market: new Market(db, auth, () => now),
    contracts: new Contracts(db, auth, () => now),
    workspaces: new Workspaces(
      db,
      auth,
      () => now,
      new FakeGitHubProvider(new FakeScanner())
    ),
    requests: new McpRequests(db)
  };
  const mcp = new MarketplaceMcp(services, () => now);
  const credentials: string[] = [];
  const session = (user: string) => {
    const value = auth.issueUserSession(user);
    credentials.push(value);
    return value;
  };
  const buyer = session("demo-buyer"),
    seller = session("demo-seller");
  const alternative = session("demo-alternative"),
    outsider = session("other-buyer");
  const agent = (human: string, id: string, scopes: Scope[]) => {
    const value = auth.issueAgentToken(human, id, scopes);
    credentials.push(value);
    return value;
  };
  const projectScopes: Scope[] = ["read", "write"].map(action => ({
    kind: "project",
    resourceId: "demo-project",
    action: action as "read" | "write"
  }));
  const buyerAgent = agent(buyer, "demo-buyer-agent", projectScopes);
  const sellerAgent = agent(seller, "demo-seller-agent", projectScopes);
  const readonly = agent(seller, "demo-seller-agent", [projectScopes[0]!]);
  const report: Report = {
    mode: "offline-fake",
    tasks: [],
    contracts: [],
    outcomes: [],
    steps: []
  };
  let sequence = 0;
  const key = () => `demo-${++sequence}`;
  const record = (action: string, requestId: string, result: string) => {
    const rows = db
      .prepare(
        "SELECT sequence,event,result FROM audit_events WHERE request_id=? ORDER BY sequence"
      )
      .all(requestId);
    assert.ok(rows.length > 0, `audit missing: ${action}`);
    report.steps.push({
      action,
      request_id: requestId,
      result,
      audit: rows.map(r => ({
        sequence: Number(r.sequence),
        event: String(r.event),
        result: String(r.result)
      }))
    });
  };
  const api = async <T>(
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
    error?: string
  ): Promise<T> => {
    const response = await localRequest(services, token, path, method, body);
    const envelope = JSON.parse(response.text);
    assert.equal(envelope.request_id, response.headers["x-request-id"]);
    assert.equal(envelope.error?.code, error, `${method} ${path}`);
    assert.equal(envelope.ok, !error);
    assert.equal(response.status === 200, !error);
    record(`${method} ${path}`, envelope.request_id, error || "success");
    return envelope.data as T;
  };
  const clients: {
    client: Client;
    server: ReturnType<MarketplaceMcp["server"]>;
  }[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "offline-demo", version: "1" });
    const server = mcp.server(token);
    const [left, right] = InMemoryTransport.createLinkedPair();
    clients.push({ client, server });
    await server.connect(right);
    await client.connect(left);
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
    error?: string
  ) => {
    const input = { request_id: key(), ...args };
    const raw = await client.callTool({ name, arguments: input });
    const result = outputSchema.parse(raw.structuredContent) as Envelope;
    assert.equal(result.request_id, input.request_id);
    assert.equal(result.error?.code, error, name);
    record(
      `MCP ${name}`,
      result.request_id,
      error ||
        (result.requires_human_confirmation
          ? "human_confirmation_required"
          : result.status)
    );
    return result;
  };
  try {
    for (const path of [
      "/requirements",
      "/market",
      "/contracts",
      "/workspaces"
    ]) {
      const page = await localRequest(services, "", path!);
      assert.equal(page.status, 303);
      assert.equal(page.headers.location, "/login?expired=1");
      assert.ok(!page.text.includes('id="session"'));
    }
    const buy = await connect(buyerAgent),
      sell = await connect(sellerAgent),
      read = await connect(readonly);
    assert.ok(
      (await buy.listTools()).tools.some(t => t.name === "accept_milestone")
    );
    assert.equal(
      (await sell.listResourceTemplates()).resourceTemplates.length,
      8
    );
    assert.equal((await buy.listPrompts()).prompts.length, 3);
    // Foreign tenant has a real private task, indistinguishable from a missing task.
    const privateTask = await api<Task>(outsider, "/api/requirements", "POST", {
      projectId: "other-project",
      draft: { values: { goal: "隔离租户的合成草稿" }, publicFields: [] }
    });
    for (const id of [privateTask.id, "missing-task"])
      await call(sell, "get_task_context", { task_id: id }, "FORBIDDEN");

    for (const outcome of ["completed", "disputed"]) {
      const created = await call(buy, "draft_task", {
        project_id: "demo-project",
        description: "实现整数求和函数"
      });
      const task = (created.data as unknown) as Task;
      report.tasks.push(task.id);
      assert.equal(task.version, 0);
      const validation = await call(buy, "validate_task", { task_id: task.id });
      assert.ok((validation.data as { missing: unknown[] }).missing.length > 0);
      await api(buyer, `/api/requirements/${task.id}`, "PUT", {
        revision: task.revision,
        draft
      });
      const valid = await call(buy, "validate_task", { task_id: task.id });
      assert.deepEqual((valid.data as { missing: unknown[] }).missing, []);
      const handoffId = key();
      const handoff = await call(buy, "publish_task", {
        task_id: task.id,
        request_id: handoffId
      });
      assert.equal(handoff.requires_human_confirmation, true);
      assert.equal(
        (await api<Task>(buyer, `/api/requirements/${task.id}`)).version,
        0
      );
      let preview = await api<{ confirmation: string }>(
        buyer,
        `/api/requirements/${task.id}/preview`,
        "POST",
        {}
      );
      if (outcome === "completed") {
        now += 600001;
        await call(
          buy,
          "publish_task",
          { task_id: task.id, request_id: handoffId },
          "CONFIRMATION_EXPIRED"
        );
        await api(
          buyer,
          `/api/requirements/${task.id}/publish`,
          "POST",
          { confirmation: preview.confirmation, confirmed: true },
          "STALE_CONFIRMATION"
        );
        assert.equal(
          (await api<Task>(buyer, `/api/requirements/${task.id}`)).version,
          0
        );
        preview = await api(
          buyer,
          `/api/requirements/${task.id}/preview`,
          "POST",
          {}
        );
      }
      await api(
        buyerAgent,
        `/api/requirements/${task.id}/publish`,
        "POST",
        { confirmation: preview.confirmation, confirmed: true },
        "FORBIDDEN"
      );
      await api(buyer, `/api/requirements/${task.id}/publish`, "POST", {
        confirmation: preview.confirmation,
        confirmed: true
      });
      assert.equal(
        (await api<Task>(buyer, `/api/requirements/${task.id}`)).version,
        1
      );
      await call(sell, "get_task_context", { task_id: task.id });
      await call(
        read,
        "draft_bid",
        { task_id: task.id, proposal },
        "FORBIDDEN"
      );
      const offered = await call(sell, "draft_bid", {
        task_id: task.id,
        proposal
      });
      const bid = (offered.data as unknown) as Bid;
      const submitHandoff = await call(sell, "submit_bid", { bid_id: bid.id });
      assert.equal(submitHandoff.requires_human_confirmation, true);
      const bidPreview = await api<{ confirmation: string }>(
        seller,
        `/api/market/bids/${bid.id}/preview`,
        "POST",
        {}
      );
      await api(
        sellerAgent,
        `/api/market/bids/${bid.id}/submit`,
        "POST",
        { confirmation: bidPreview.confirmation, confirmed: true },
        "FORBIDDEN"
      );
      await api(seller, `/api/market/bids/${bid.id}/submit`, "POST", {
        confirmation: bidPreview.confirmation,
        confirmed: true
      });
      const other = await api<Bid>(
        alternative,
        `/api/market/${task.id}/bids`,
        "POST",
        { proposal: { ...proposal, price: 80, days: 5, risk: "medium" } }
      );
      const otherPreview = await api<{ confirmation: string }>(
        alternative,
        `/api/market/bids/${other.id}/preview`,
        "POST",
        {}
      );
      await api(alternative, `/api/market/bids/${other.id}/submit`, "POST", {
        confirmation: otherPreview.confirmation,
        confirmed: true
      });
      const comparison = await call(buy, "compare_bids", { task_id: task.id });
      assert.equal((comparison.data as unknown[]).length, 2);
      assert.equal((comparison.data as { id: string }[])[0]!.id, bid.id);
      assert.equal(
        (await call(buy, "select_bid", { bid_id: bid.id }))
          .requires_human_confirmation,
        true
      );
      await api(
        buyer,
        "/api/contracts/select",
        "POST",
        { bidId: bid.id, confirmed: false },
        "CONFIRMATION_REQUIRED"
      );
      let contract = await api<Contract>(
        buyer,
        "/api/contracts/select",
        "POST",
        { bidId: bid.id, confirmed: true }
      );
      report.contracts.push(contract.id);
      assert.equal(contract.status, "draft");
      const contractPath = `/api/contracts/${contract.id}`;
      const command = async (
        token: string,
        action: string,
        extra: Record<string, unknown> = {},
        error?: string
      ) => {
        contract = await api<Contract>(buyer, contractPath);
        const result = await api<Contract>(
          token,
          contractPath + "/commands",
          "POST",
          {
            action,
            version: contract.version,
            revision: contract.revision,
            requestKey: key(),
            confirmed: true,
            reason: {
              code: "demo_review",
              detail: "合成责任主体核对范围和交付证据"
            },
            ...extra
          },
          error
        );
        if (!error) contract = result;
      };
      await command(buyer, "transition", { to: "pending_confirmation" });
      assert.equal(contract.status, "pending_confirmation");
      await command(buyer, "confirm");
      assert.equal(contract.status, "pending_confirmation");
      await command(seller, "confirm");
      assert.equal(contract.status, "active");
      assert.equal(
        contract.events.filter(e => e.kind === "human_confirmation").length,
        2
      );
      assert.equal(contract.milestones[0]!.status, "planned");
      const scoped = (action: "read" | "write"): Scope => ({
        kind: "contract",
        resourceId: contract.id,
        action
      });
      const deliveryToken = agent(seller, "demo-seller-agent", [
        scoped("read"),
        scoped("write")
      ]);
      const reviewToken = agent(buyer, "demo-buyer-agent", [
        scoped("read"),
        scoped("write")
      ]);
      const delivery = await connect(deliveryToken),
        review = await connect(reviewToken);
      await call(
        sell,
        "get_contract",
        { contract_id: contract.id },
        "FORBIDDEN"
      );
      await api(outsider, contractPath, "GET", undefined, "FORBIDDEN");
      const workspacePath = `/api/workspaces/${contract.id}`;
      const work = (
        action: string,
        extra: Record<string, unknown> = {},
        token = deliveryToken,
        error?: string
      ) =>
        api(
          token,
          workspacePath + "/commands",
          "POST",
          { action, version: 1, requestKey: key(), ...extra },
          error
        );
      await work(
        "create_workspace_branch",
        { branch: "delivery" },
        deliveryToken,
        "FORBIDDEN"
      );
      await work(
        "authorize",
        {
          actorId: "demo-seller-agent",
          permission: "branch",
          ttlMs: 900000,
          confirmed: true
        },
        buyer
      );
      const readContract = agent(seller, "demo-seller-agent", [scoped("read")]);
      await work(
        "create_workspace_branch",
        { branch: "delivery" },
        readContract,
        "FORBIDDEN"
      );
      assert.equal(
        (
          await call(delivery, "create_workspace_branch", {
            workspace_id: contract.id,
            version: 1,
            branch: "delivery"
          })
        ).requires_human_confirmation,
        true
      );
      await work("create_workspace_branch", { branch: "delivery" });
      await work(
        "commit",
        {
          branch: "delivery",
          files: {
            "sum.ts": "export const sum = (a: number, b: number) => a + b;\n"
          },
          summary: "实现求和"
        },
        deliveryToken,
        "FORBIDDEN"
      );
      for (const permission of [
        "commit",
        "check",
        "pull_request",
        "artifact",
        "submit"
      ])
        await work(
          "authorize",
          {
            actorId: "demo-seller-agent",
            permission,
            ttlMs: 900000,
            confirmed: true
          },
          buyer
        );
      const milestoneId = String(contract.milestones[0]!.id);
      const safeState = async () => {
        const c = await api<Contract>(buyer, contractPath);
        const w = await api<ReturnType<Workspaces["read"]>>(
          buyer,
          workspacePath
        );
        assert.equal(c.settlement, "unsettled");
        assert.deepEqual(w.deployments, []);
        return w;
      };
      const deliver = async (revision: number) => {
        await work("commit", {
          branch: "delivery",
          summary: `求和实现修订 ${revision}`,
          files: {
            "sum.ts": `// revision ${revision}\nexport const sum = (a: number, b: number) => a + b;\n`
          }
        });
        const w = await safeState();
        const sha = w.commits.at(-1)!.sha;
        await work(
          "submit_milestone",
          { sha, milestoneId, summary: "证据不足" },
          deliveryToken,
          "EVIDENCE_INCOMPLETE"
        );
        for (const kind of ["test", "typecheck"]) {
          assert.equal(
            (
              await call(delivery, "run_check", {
                workspace_id: contract.id,
                version: 1,
                sha,
                kind
              })
            ).requires_human_confirmation,
            true
          );
          await work("run_check", { sha, kind });
        }
        await work("create_pull_request", { sha });
        const content = `离线模拟制品 revision ${revision}`;
        await work("upload_artifact", {
          sha,
          name: "report.txt",
          content,
          checksum: checksum(content)
        });
        await work("submit_milestone", {
          sha,
          milestoneId,
          summary: "完整离线证据，请责任主体核对"
        });
        const after = await safeState();
        assert.ok(after.checks.filter(c => c.sha === sha).every(c => c.passed));
        assert.equal(after.artifacts.at(-1)!.checksum, checksum(content));
        assert.equal(after.pullRequests.at(-1)!.sha, sha);
        assert.equal(
          (await api<Contract>(buyer, contractPath)).milestones[0]!.status,
          "submitted"
        );
      };
      await command(seller, "milestone", { milestoneId, to: "in_progress" });
      assert.equal(contract.milestones[0]!.status, "in_progress");
      await command(buyer, "settlement", {}, "INVALID_TRANSITION");
      await deliver(1);
      const reviewArgs = {
        contract_id: contract.id,
        milestone_id: milestoneId,
        reason: { code: "evidence", detail: "核对模拟证据" }
      };
      const recommendation = await call(review, "review_milestone", {
        contract_id: contract.id,
        milestone_id: milestoneId
      });
      assert.equal((recommendation.data as { final: boolean }).final, false);
      if (outcome === "completed") {
        assert.equal(
          (await call(review, "request_changes", reviewArgs))
            .requires_human_confirmation,
          true
        );
        await command(
          reviewToken,
          "milestone",
          { milestoneId, to: "changes_requested" },
          "FORBIDDEN"
        );
        await command(buyer, "milestone", {
          milestoneId,
          to: "changes_requested"
        });
        assert.equal(contract.milestones[0]!.status, "changes_requested");
        await deliver(2);
        assert.equal(
          (await call(review, "accept_milestone", reviewArgs))
            .requires_human_confirmation,
          true
        );
        await command(
          buyer,
          "milestone",
          { milestoneId, to: "accepted", confirmed: false },
          "CONFIRMATION_REQUIRED"
        );
        await command(
          reviewToken,
          "milestone",
          { milestoneId, to: "accepted" },
          "FORBIDDEN"
        );
        await safeState();
        await command(buyer, "milestone", { milestoneId, to: "accepted" });
        assert.equal(contract.milestones[0]!.status, "accepted");
        await command(buyer, "transition", { to: "completed" });
      } else {
        assert.equal(
          (
            await call(review, "open_dispute", {
              contract_id: contract.id,
              reason: reviewArgs.reason
            })
          ).requires_human_confirmation,
          true
        );
        await command(buyer, "transition", { to: "disputed" });
        const before = await safeState();
        await work(
          "commit",
          {
            branch: "delivery",
            summary: "争议后禁止写入",
            files: { "sum.ts": "changed" }
          },
          deliveryToken,
          "CONTRACT_NOT_ACTIVE"
        );
        await command(
          buyer,
          "milestone",
          { milestoneId, to: "accepted" },
          "DISPUTE_FROZEN"
        );
        assert.deepEqual(await safeState(), before);
      }
      assert.equal(contract.status, outcome);
      await safeState();
      report.outcomes.push(outcome);
    }
    // With real project and contract grants, all four pages share the same shell.
    for (const [path, expected] of [
      ["/requirements", "验收"],
      ["/market", "报价"],
      ["/contracts", "合同"],
      ["/workspaces", "checksum"]
    ]) {
      const page = await localRequest(services, buyer, path!);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(expected!));
      assert.ok(page.text.includes('aria-label="主导航"'));
      assert.ok(page.text.includes('id="project"'));
      assert.ok(!page.text.includes('id="session"'));
    }
    // Raw credentials are never included in evidence or audit output; revoke demo sessions.
    const serialized =
      JSON.stringify(report) +
      JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    for (const value of credentials) assert.ok(!serialized.includes(value));
    for (const value of credentials) {
      const owner = auth.identity(value).responsibleUserId;
      const human =
        owner === "demo-buyer"
          ? buyer
          : owner === "demo-seller"
          ? seller
          : owner === "demo-alternative"
          ? alternative
          : outsider;
      if (value !== human) auth.revoke(human, tokenDigest(value));
    }
    for (const value of [buyer, seller, alternative, outsider])
      auth.revoke(value, tokenDigest(value));
    return report;
  } finally {
    for (const { client, server } of clients) {
      await client.close();
      await server.close();
    }
  }
}
