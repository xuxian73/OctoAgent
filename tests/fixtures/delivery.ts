import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Authorization } from "../../packages/auth/src/index.js";
import { Files } from "../../packages/database/src/files.js";
import { zip } from "./zip.js";
/** Explicit offline controlled scanner, never the deployment scanner or a security claim. */
export const controlledScanner = {
  name: "controlled-offline-test-adapter",
  simulated: false,
  scan: () => "clean" as const
};
export async function stageZip(
  f: { db: DatabaseSync; auth: Authorization; seller: string },
  id: string,
  milestoneId: string
) {
  const actor = f.auth.identity(f.seller).id;
  for (const permission of ["artifact", "submit"])
    f.db
      .prepare("INSERT OR REPLACE INTO delivery_permissions VALUES (?,?,?,?)")
      .run(id, actor, permission, Date.now() + 900000);
  const files = new Files(f.db, f.auth, controlledScanner);
  const version = Number(
    f.db.prepare("SELECT version FROM contracts WHERE id=?").get(id)!.version
  );
  const file = files.upload(
    f.seller,
    {
      kind: "artifact",
      resourceId: id,
      version,
      revision: 0,
      milestoneId,
      sha: "",
      name: "delivery.zip",
      mime: "application/zip",
      requestKey: randomUUID()
    },
    zip(randomUUID())
  );
  await files.scan(String(file.id));
  return {
    fileId: file.id,
    summary: "交付说明",
    instructions: "阅读 README",
    knownIssues: "无"
  };
}
export function deliveryId(db: DatabaseSync, milestoneId: string) {
  return db
    .prepare(
      "SELECT id FROM zip_deliveries WHERE milestone_id=? ORDER BY delivery_version DESC LIMIT 1"
    )
    .get(milestoneId)?.id;
}
