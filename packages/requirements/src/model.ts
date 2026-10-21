export const taskTypes = [
  "新功能",
  "Bug 修复",
  "重构",
  "性能",
  "部署",
  "监控",
  "数据迁移",
  "安全加固"
] as const;
export const budgetTypes = ["固定总价", "按里程碑", "按小时"] as const;
export const currency = "CNY";
export const fields = {
  goal: "目标与背景",
  outcome: "期望结果",
  stack: "技术栈",
  repository: "现有仓库（无则填无）",
  environment: "环境限制",
  taskType: "任务类型",
  budgetType: "预算方式",
  amount: "预算金额（按小时为时薪）",
  currency: "结算币种",
  timeline: "期望时间",
  milestones: "里程碑及预算分配",
  deliverables: "交付物",
  acceptance: "验收标准",
  permissions: "所需权限",
  exclusions: "不可触碰范围"
} as const;
export type Field = keyof typeof fields;
export interface Draft {
  values: Partial<Record<Field, string>>;
  publicFields: Field[];
}
export class RequirementError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}
export function parseDraft(input: unknown): Draft {
  if (!input || typeof input !== "object")
    throw new RequirementError("INVALID_DRAFT");
  const { values, publicFields = [] } = input as Draft;
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !Array.isArray(publicFields)
  )
    throw new RequirementError("INVALID_DRAFT");
  const result: Draft = { values: {}, publicFields: [] };
  for (const key of Object.keys(values)) {
    if (
      !Object.hasOwn(fields, key) ||
      typeof values[key as Field] !== "string" ||
      values[key as Field]!.length > 10000
    )
      throw new RequirementError("INVALID_FIELD");
    result.values[key as Field] = values[key as Field]!.trim();
  }
  if (publicFields.some(key => !Object.hasOwn(fields, key)))
    throw new RequirementError("INVALID_FIELD");
  result.publicFields = [...new Set(publicFields)];
  if (result.values.currency && result.values.currency !== currency)
    throw new RequirementError("UNSUPPORTED_CURRENCY");
  if (
    result.values.taskType &&
    !taskTypes.includes(result.values.taskType as typeof taskTypes[number])
  )
    throw new RequirementError("INVALID_TASK_TYPE");
  if (
    result.values.budgetType &&
    !budgetTypes.includes(
      result.values.budgetType as typeof budgetTypes[number]
    )
  )
    throw new RequirementError("INVALID_BUDGET_TYPE");
  return result;
}
export function validate(draft: Draft) {
  const missing = (Object.keys(fields) as Field[]).filter(
    key => !draft.values[key]
  );
  const invalid: Field[] = [];
  if (
    draft.values.amount &&
    (!/^\d+(\.\d{1,2})?$/.test(draft.values.amount) ||
      Number(draft.values.amount) <= 0 ||
      Number(draft.values.amount) > 1e12)
  )
    invalid.push("amount");
  const risks = [
    "自由文本默认私密；公开前请检查是否包含密钥、生产地址或私人数据。"
  ];
  if (["部署", "数据迁移", "安全加固"].includes(draft.values.taskType || ""))
    risks.push("涉及高风险操作：请明确环境、授权和回滚验收边界。");
  if (draft.values.budgetType === "按里程碑")
    risks.push("请核对里程碑预算分配与总预算一致。");
  return { missing, invalid, risks };
}
export function summary(draft: Draft) {
  const v = draft.values;
  return {
    scope: {
      goal: v.goal,
      outcome: v.outcome,
      stack: v.stack,
      repository: v.repository,
      environment: v.environment,
      taskType: v.taskType,
      timeline: v.timeline,
      permissions: v.permissions,
      exclusions: v.exclusions
    },
    budget: {
      type: v.budgetType,
      amount: v.amount,
      currency: v.currency,
      milestones: v.milestones
    },
    deliverables: v.deliverables,
    acceptance: v.acceptance
  };
}
