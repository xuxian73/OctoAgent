import { initializeDemo } from "./index.js";
try {
  const report = await initializeDemo(process.argv[2] || ".data/demo");
  console.log(
    `离线演示验收通过：${report.outcomes.join(" / ")}；${
      report.steps.length
    } 条请求及审计关联。`
  );
  console.log(
    "产物：目标目录中的 demo.sqlite、report.json、repositories.json。重复运行复用已有资源。"
  );
} catch {
  console.error(
    "离线演示未完成；请检查环境、目标目录与端到端测试。未输出凭据或内部错误内容。"
  );
  process.exitCode = 1;
}
