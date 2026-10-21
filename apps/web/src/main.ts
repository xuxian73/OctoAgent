import { ApiResult, Health } from "../../../packages/shared/src/index.js";
async function showHealth(): Promise<void> {
  const status = document.getElementById("status");
  if (!status) return;
  try {
    const response = await fetch("/api/health");
    const result: ApiResult<Health> = await response.json();
    status.textContent =
      response.ok && result.ok ? "服务运行正常" : "服务暂时不可用";
  } catch {
    status.textContent = "无法连接服务";
  }
}
void showHealth();
