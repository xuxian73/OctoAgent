// Independent local acceptance instance: never loads .env or seeds accounts.
import { accessSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try {
  accessSync(new URL("../dist/apps/server/src/main.js", import.meta.url));
} catch {
  console.error("缺少构建产物：请先安装 lockfile 依赖并运行 npm run build。");
  process.exit(1);
}
const directory = mkdtempSync(join(tmpdir(), "octo-zip-acceptance-"));
process.env.DATABASE_URL = "file:" + join(directory, "acceptance.sqlite");
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.NODE_ENV = "development";
try {
  accessSync(process.env.CLAMAV_EXECUTABLE || "/usr/bin/clamscan", constants.X_OK);
} catch {
  console.error("未验证：缺少可执行的 ClamAV。配置 CLAMAV_EXECUTABLE 绝对路径及病毒库；上传不会放行。");
}
const { openDatabase } = await import("../dist/packages/database/src/index.js");
const db = openDatabase(process.env.DATABASE_URL);
db.migrate();
db.close();
const { zip } = await import("../dist/packages/security/src/zip-sample.js");
for (const version of [1, 2])
  writeFileSync(join(directory, `delivery-v${version}.zip`), zip(`Acceptance version ${version}\n`));
console.log(`Independent database, ZIP samples and evidence directory: ${directory}`);
console.log("Real ClamAV only; missing scanner/signatures blocks delivery. No accounts precreated.");
await import("../dist/apps/server/src/main.js");
