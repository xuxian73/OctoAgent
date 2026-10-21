// Trusted CLI protocol fixture only. Never executes repository code or claims isolation.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const [record, mode, ...args] = process.argv.slice(2);
appendFileSync(record!, JSON.stringify(args) + "\n");
if (args[0] === "rm" && mode === "cleanup-fail") process.exit(1);
if (args[0] === "image") {
  if (mode === "missing-image") process.exit(1);
  console.log(
    args.includes("{{json .Config.Volumes}}")
      ? mode === "unsafe-image"
        ? '{"/data":{}}'
        : "null"
      : args.at(-1)
  );
} else if (args[0] === "create") {
  const mount = args[args.indexOf("--mount") + 1]!;
  const path = mount.split("src=")[1]!.split(",dst=")[0]!;
  writeFileSync(record! + ".snapshot", readFileSync(path + "/src/source.ts"));
} else if (args[0] === "start") {
  if (mode === "timeout") setTimeout(() => {}, 60000);
  else
    process.stdout.write(
      mode === "output" ? "sensitive arbitrary output".repeat(10000) : "PASS\n"
    );
} else if (args[0] === "inspect")
  console.log(
    JSON.stringify({
      Status: "exited",
      StartedAt: "2000-01-01T00:00:00.000000000Z",
      FinishedAt: "2000-01-01T00:00:01.000000000Z",
      ExitCode: mode === "fail" ? 7 : 0,
      OOMKilled: false,
      Error: ""
    })
  );
