import { z } from "zod";
import { fields } from "../../requirements/src/model.js";
const text = z
  .string()
  .trim()
  .min(1)
  .max(10000);
const id = z
  .string()
  .min(1)
  .max(200);
const strings = z
  .array(text)
  .min(1)
  .max(100);
const positive = z
  .number()
  .positive()
  .max(1e9);
const reason = z.strictObject({ code: text, detail: text });
const proposal = z.strictObject({
  summary: text,
  milestones: strings,
  hours: positive,
  days: positive,
  price: positive,
  prerequisites: strings,
  risks: strings,
  risk: z.enum(["low", "medium", "high"]),
  permissions: strings,
  evidence: strings,
  capabilities: strings
});
const draft = z.strictObject({
  values: z.strictObject(
    Object.fromEntries(
      Object.keys(fields).map(k => [
        k,
        z
          .string()
          .max(10000)
          .optional()
      ])
    )
  ),
  publicFields: z
    .array(z.enum(Object.keys(fields) as [string, ...string[]]))
    .max(15),
  market: z
    .strictObject({
      deadline: z
        .number()
        .int()
        .positive(),
      durationDays: z
        .number()
        .int()
        .positive(),
      risk: z.enum(["low", "medium", "high"]),
      allowAgents: z.boolean(),
      capabilities: z
        .array(text)
        .max(100)
        .optional()
    })
    .optional()
});
const task = { task_id: id };
const bid = { bid_id: id };
const contract = { contract_id: id };
const milestone = { ...contract, milestone_id: id };
const workspace = {
  workspace_id: id,
  version: z
    .number()
    .int()
    .positive()
};
const shapes = {
  draft_task: { project_id: id, description: text, draft: draft.optional() },
  validate_task: task,
  publish_task: task,
  list_bids: task,
  compare_bids: {
    ...task,
    sort: z.enum(["price", "days", "risk", "capabilities"]).optional()
  },
  ask_bidder_question: { ...task, recipient: id, topic: text, text },
  select_bid: bid,
  review_milestone: milestone,
  request_changes: { ...milestone, reason },
  accept_milestone: { ...milestone, reason },
  open_dispute: { ...contract, reason },
  search_tasks: {
    project_id: id.optional(),
    filters: z
      .strictObject({
        stack: text.optional(),
        capabilities: text.optional(),
        permissions: text.optional(),
        taskType: text.optional(),
        budgetType: text.optional(),
        risk: z.enum(["low", "medium", "high"]).optional(),
        allowAgents: z.enum(["true", "false"]).optional(),
        maxDays: text.optional(),
        deadlineAfter: text.optional()
      })
      .optional()
  },
  get_task_context: task,
  draft_bid: { ...task, proposal },
  submit_bid: bid,
  withdraw_bid: bid,
  request_clarification: { ...task, topic: text, text },
  get_contract: contract,
  get_milestones: contract,
  create_workspace_branch: { ...workspace, branch: text },
  run_check: { ...workspace, sha: text, kind: z.enum(["test", "typecheck"]) },
  create_pull_request: { ...workspace, sha: text },
  submit_milestone: {
    ...workspace,
    milestone_id: id,
    sha: text,
    summary: text,
    preview_url: z.url().optional()
  },
  report_blocker: { ...workspace, text }
};
export const schemas = Object.fromEntries(
  Object.entries(shapes).map(([name, shape]) => [
    name,
    z.strictObject({ request_id: id, ...shape })
  ])
);
export const confirmationTools = new Set([
  "publish_task",
  "submit_bid",
  "withdraw_bid",
  "select_bid",
  "request_changes",
  "accept_milestone",
  "open_dispute",
  "create_workspace_branch",
  "run_check",
  "create_pull_request",
  "submit_milestone"
]);

// Business payloads are explicit; only audit-event extension payloads are open records.
const integer = z
  .number()
  .int()
  .nonnegative();
const validation = z.strictObject({
  missing: z.array(z.enum(Object.keys(fields) as [string, ...string[]])),
  invalid: z.array(z.enum(Object.keys(fields) as [string, ...string[]])),
  risks: z.array(z.string())
});
const attachment = z.strictObject({
  id,
  name: z.string(),
  mime: z.string(),
  size: integer
});
const requirement = z.strictObject({
  id,
  projectId: id,
  revision: integer,
  version: integer,
  draft,
  validation,
  attachments: z.array(
    attachment.extend({ private: z.union([z.literal(0), z.literal(1)]) })
  ),
  changes: z.array(
    z.strictObject({ version: integer, changed_fields: z.string() })
  )
});
const timelineEvent = z.strictObject({
  sequence: integer,
  kind: text,
  actor_id: id,
  created_at: integer,
  payload: z.record(z.string(), z.json())
});
const taskDetail = z.strictObject({
  id,
  version: integer,
  market: draft.shape.market.unwrap(),
  values: draft.shape.values,
  attachments: z.array(attachment),
  timeline: z.array(timelineEvent)
});
const bidDetail = z.strictObject({
  id,
  owner_id: id,
  status: z.enum(["draft", "submitted", "withdrawn"]),
  version: integer,
  task_version: integer,
  stale: z.boolean(),
  requirement_id: id,
  proposal
});
const milestoneDetail = z.strictObject({
  id,
  contract_id: id,
  version: integer,
  title: z.string(),
  status: z.enum([
    "planned",
    "in_progress",
    "submitted",
    "changes_requested",
    "accepted",
    "rejected"
  ])
});
const contractStatus = z.enum([
  "draft",
  "pending_confirmation",
  "active",
  "paused",
  "completed",
  "cancelled",
  "disputed"
]);
const contractDetail = z.strictObject({
  id,
  requirement_id: id,
  bid_id: id,
  buyer_id: id,
  seller_id: id,
  version: integer,
  revision: integer,
  status: contractStatus,
  settlement: z.enum(["unsettled", "manually_confirmed"]),
  versions: z.array(
    z.strictObject({
      version: integer,
      terms: z.strictObject({
        scope: z.string(),
        deliverables: z.string(),
        acceptance: z.string(),
        changeRules: z.string(),
        price: positive,
        currency: z.literal("CNY"),
        milestones: strings
      })
    })
  ),
  milestones: z.array(milestoneDetail),
  confirmations: z.array(
    z.strictObject({
      contract_id: id,
      version: integer,
      party: z.enum(["buyer", "seller"]),
      actor_id: id,
      created_at: integer
    })
  ),
  events: z.array(timelineEvent.extend({ contract_id: id, version: integer }))
});
const check = z.strictObject({
  sha: text,
  kind: z.enum(["test", "typecheck"]),
  passed: z.boolean(),
  log: z.string()
});
const pullRequest = z.strictObject({
  sha: text,
  url: z.url(),
  summary: z.string()
});
const artifact = z.strictObject({
  sha: text,
  name: text,
  checksum: text,
  size: integer
});
const submission = z.strictObject({
  milestoneId: id,
  sha: text,
  version: integer,
  summary: z.string(),
  previewUrl: z.url().nullable(),
  risks: z.array(z.string()),
  checks: z.array(check),
  pullRequests: z.array(pullRequest),
  artifacts: z.array(artifact)
});
const workspaceDetail = z.strictObject({
  contractId: id,
  version: integer,
  status: contractStatus,
  taskVersion: integer,
  provider: z.literal("offline-fake"),
  branches: z.record(z.string(), z.string()),
  commits: z.array(
    z.strictObject({
      sha: text,
      branch: text,
      summary: z.string(),
      version: integer,
      files: z.record(z.string(), z.string())
    })
  ),
  checks: z.array(check),
  pullRequests: z.array(pullRequest),
  artifacts: z.array(artifact),
  discussions: z.array(z.string()),
  risks: z.array(z.string()),
  submissions: z.array(submission),
  deployments: z.array(
    z.strictObject({
      requires_human_confirmation: z.literal(true),
      action: text,
      object: text,
      impactScope: text,
      expiresAt: integer,
      executed: z.literal(false),
      productionEnabled: z.literal(false)
    })
  ),
  auditEventReferences: z.array(integer)
});
const common = {
  request_id: id,
  status: text,
  next_step: text,
  summary: text,
  risk_warning: text,
  content_trust: z.literal("untrusted")
};
const confirmationShape = z.strictObject({
  scope: text,
  affected_objects: z.array(id).min(1),
  expires_at: integer,
  parameters: z.record(z.string(), z.json()),
  context: z.json()
});
const failure = z.strictObject({
  ...common,
  status: z.literal("error"),
  requires_human_confirmation: z.literal(false),
  error: z.strictObject({ code: text })
});
const success = (data: z.ZodType) =>
  z.strictObject({
    ...common,
    requires_human_confirmation: z.literal(false),
    data
  });
const pending = (confirmation: z.ZodType) =>
  z.strictObject({
    ...common,
    requires_human_confirmation: z.literal(true),
    confirmation
  });
export const outputSchema = z.union([
  failure,
  success(z.json()),
  pending(confirmationShape)
]);
export interface Envelope {
  risk_warning: string;
  content_trust: "untrusted";
  request_id: string;
  status: string;
  next_step: string;
  summary: string;
  requires_human_confirmation: boolean;
  confirmation?: z.infer<typeof confirmationShape>;
  data?: z.infer<ReturnType<typeof z.json>>;
  error?: { code: string };
}
const dataSchemas: Record<string, z.ZodType> = {
  draft_task: requirement,
  validate_task: validation,
  list_bids: z.array(bidDetail),
  compare_bids: z.array(bidDetail),
  ask_bidder_question: integer,
  review_milestone: z.strictObject({
    milestone: milestoneDetail,
    acceptance: z.string(),
    evidence: z.array(submission),
    unresolved_risks: z.array(z.string()),
    recommendation: text,
    final: z.literal(false)
  }),
  search_tasks: z.array(taskDetail),
  get_task_context: taskDetail,
  draft_bid: bidDetail,
  request_clarification: integer,
  get_contract: contractDetail,
  get_milestones: z.array(milestoneDetail),
  report_blocker: z.strictObject({
    status: contractStatus,
    summary: text,
    next_step: text,
    result: z.strictObject({ text })
  })
};
export const outputSchemas = Object.fromEntries(
  Object.keys(shapes).map(name => {
    if (!confirmationTools.has(name))
      return [name, z.union([failure, success(dataSchemas[name]!)])];
    const context =
      name === "publish_task"
        ? requirement
        : ["submit_bid", "withdraw_bid", "select_bid"].includes(name)
        ? bidDetail
        : ["request_changes", "accept_milestone", "open_dispute"].includes(name)
        ? contractDetail
        : workspaceDetail;
    return [
      name,
      z.union([
        failure,
        pending(
          confirmationShape.extend({
            scope: z.literal(name),
            parameters: schemas[name]!,
            context
          })
        )
      ])
    ];
  })
);
