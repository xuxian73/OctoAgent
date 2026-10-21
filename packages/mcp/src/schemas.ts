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
      allowAgents: z.boolean()
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
    project_id: id,
    filters: z
      .strictObject({
        stack: text.optional(),
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
export const outputSchema = z.strictObject({
  request_id: id,
  status: text,
  next_step: text,
  summary: text,
  requires_human_confirmation: z.boolean(),
  confirmation: z
    .strictObject({
      scope: text,
      affected_objects: z.array(id).min(1),
      expires_at: z.number().int(),
      parameters: z.record(z.string(), z.json()),
      context: z.json()
    })
    .optional(),
  data: z.json().optional(),
  error: z.strictObject({ code: text }).optional()
});
export type Envelope = z.infer<typeof outputSchema>;
