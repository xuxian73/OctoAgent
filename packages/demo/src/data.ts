import { DatabaseSync } from "node:sqlite";
import { Draft, contextFields } from "../../requirements/src/model.js";
import { Proposal } from "../../requirements/src/bids.js";

// Only synthetic subjects, no login credentials or real contact information.
export function seedSubjects(db: DatabaseSync) {
  db.exec(`
    INSERT INTO organizations VALUES ('demo-org'), ('other-org');
    INSERT INTO projects VALUES ('demo-project', 'demo-org'), ('other-project', 'other-org');
    INSERT INTO users VALUES ('demo-buyer', 'member'), ('demo-seller', 'member'),
      ('demo-alternative', 'member'), ('other-buyer', 'member');
    INSERT INTO agents VALUES ('demo-buyer-agent', 'demo-buyer', 'buyer', '["TypeScript"]'),
      ('demo-seller-agent', 'demo-seller', 'seller', '["TypeScript","testing"]');
  `);
  db.exec(`INSERT INTO authorization_resources VALUES
    ('project','demo-project','demo-org','demo-project'),
    ('project','other-project','other-org','other-project');`);
  for (const [user, role, org, project] of [
    ["demo-buyer", "buyer", "demo-org", "demo-project"],
    ["demo-seller", "seller", "demo-org", "demo-project"],
    ["demo-alternative", "seller", "demo-org", "demo-project"],
    ["other-buyer", "buyer", "other-org", "other-project"]
  ]) {
    for (const membership of ["", project])
      db.prepare("INSERT INTO memberships VALUES (?,?,?,?)").run(
        user!,
        org!,
        membership!,
        role!
      );
    for (const action of ["read", "write", "delegate"])
      db.prepare("INSERT INTO resource_grants VALUES (?, 'project', ?, ?)").run(
        user!,
        project!,
        action
      );
  }
}
export const draft: Draft = {
  values: {
    goal: "为本地示例实现整数求和函数",
    outcome: "输入两个整数，返回其和",
    stack: "TypeScript",
    repository: "offline-fake：SQLite 内隔离的虚拟 Git 仓库",
    environment: "仅离线模拟，不执行仓库代码",
    taskType: "新功能",
    budgetType: "固定总价",
    amount: "100",
    currency: "CNY",
    timeline: "7 天",
    milestones: "实现与验收：100 CNY",
    deliverables: "代码、检查报告、模拟 PR、制品校验和",
    acceptance: "求和示例正确，test/typecheck 证据齐全，人工核对后验收",
    permissions: "分支、提交、检查、PR、制品、交付分别授权",
    exclusions: "禁止支付、合并、生产部署和外部网络"
  },
  publicFields: contextFields,
  market: { deadline: 9000000, durationDays: 7, risk: "low", allowAgents: true }
};
export const proposal: Proposal = {
  summary: "实现纯函数并提供离线交付证据",
  milestones: ["求和函数交付"],
  hours: 4,
  days: 2,
  price: 100,
  prerequisites: ["本地模拟仓库"],
  risks: ["模拟检查不代表真实代码执行"],
  risk: "low",
  permissions: ["受限工作区写入"],
  evidence: ["test/typecheck、PR、制品 checksum"],
  capabilities: ["TypeScript", "testing"]
};
