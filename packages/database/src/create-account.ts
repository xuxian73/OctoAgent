import { openDatabase } from "./index.js";
// Read the secret exclusively from stdin, never argv or environment variables.
async function main() {
  const [username, userId] = process.argv.slice(2);
  if (!username || !userId || process.stdin.isTTY) throw new Error("usage");
  let password = "";
  for await (const chunk of process.stdin) {
    password += chunk.toString();
    if (password.length > 258) throw new Error("input");
  }
  const database = openDatabase(
    process.env.DATABASE_URL || "file:./.data/octoagent.sqlite"
  );
  try {
    await database.accounts.create(
      username,
      userId,
      password.replace(/\r?\n$/, "")
    );
  } finally {
    password = "";
    database.close();
  }
}
void main().catch(() => {
  console.error("建号失败：请检查参数、输入长度、迁移及账号唯一性。");
  process.exitCode = 1;
});
