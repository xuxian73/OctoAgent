import { RequirementError } from "./model.js";
export const proposalFields = {
  summary: "方案摘要",
  milestones: "里程碑",
  hours: "预计工时",
  days: "预计周期（天）",
  price: "总价（CNY）",
  prerequisites: "前置条件",
  risks: "风险说明",
  risk: "风险等级",
  permissions: "访问权限需求",
  evidence: "可交付证据",
  capabilities: "能力标签"
} as const;
export interface Proposal {
  summary: string;
  milestones: string[];
  hours: number;
  days: number;
  price: number;
  prerequisites: string[];
  risks: string[];
  risk: "low" | "medium" | "high";
  permissions: string[];
  evidence: string[];
  capabilities: string[];
}
export function parseProposal(input: unknown): Proposal {
  const p = input as Proposal;
  if (
    !p ||
    typeof p.summary !== "string" ||
    !p.summary.trim() ||
    p.summary.length > 10000 ||
    !["low", "medium", "high"].includes(p.risk)
  )
    throw new RequirementError("INVALID_PROPOSAL");
  for (const key of ["hours", "days", "price"] as const)
    if (
      typeof p[key] !== "number" ||
      !Number.isFinite(p[key]) ||
      p[key] <= 0 ||
      p[key] > 1e9
    )
      throw new RequirementError("INVALID_PROPOSAL");
  for (const key of [
    "milestones",
    "prerequisites",
    "risks",
    "permissions",
    "evidence",
    "capabilities"
  ] as const)
    if (
      !Array.isArray(p[key]) ||
      !p[key].length ||
      p[key].length > 100 ||
      p[key].some(v => typeof v !== "string" || !v.trim() || v.length > 10000)
    )
      throw new RequirementError("INVALID_PROPOSAL");
  return (Object.fromEntries(
    Object.keys(proposalFields).map(key => [key, p[key as keyof Proposal]])
  ) as unknown) as Proposal;
}
