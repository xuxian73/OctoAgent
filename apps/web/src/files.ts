import { sessionHeaders } from "./session.js";
import { apiRequest } from "./client.js";
export interface UploadBinding {
  kind: "requirement" | "artifact";
  resourceId: string;
  version: number;
  revision: number;
  milestoneId: string;
  sha: string;
}
const types: Record<string, string> = {
  ts: "text/plain",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip"
};
export function renderFiles() {
  return `<section id="private-files"><h2>私有文件</h2><p>文件隔离保存；仅当前字节通过真实扫描后可下载。测试扫描明确标记模拟，不代表真实安全扫描。ZIP 不写入应用目录或执行；扫描器受限读取归档内容。每版本最多 20 个文件，每个最多 10 MiB。</p><label for="private-file">选择文件</label><input type="file" id="private-file" accept=".ts,.txt,.md,.json,.zip"><button id="file-upload" type="button">上传真实字节</button><button id="file-refresh" type="button">刷新文件状态</button><progress aria-label="文件传输进度" id="file-progress" max="100" value="0"></progress><p id="file-status" role="status"></p><ul id="file-list"></ul></section>`;
}
export function mountFiles(root: Document, binding: () => UploadBinding) {
  if (!root.getElementById("private-files")) return;
  const el = (id: string) => root.getElementById(id)!;
  const status = el("file-status");
  const progress = el("file-progress") as HTMLProgressElement;
  if (binding().kind === "artifact")
    (el("private-file") as HTMLInputElement).accept = ".zip";
  let pending: { file: File; binding: string; key: string } | undefined;
  let active: XMLHttpRequest | undefined;
  let generation = 0;
  let retired = false;
  const clear = () => {
    generation++;
    active?.abort();
    pending = undefined;
    el("file-list").replaceChildren();
    progress.value = 0;
    status.textContent = "";
  };
  root.addEventListener("session-ended", () => {
    retired = true;
    clear();
  });
  // Bind before the workspace's input handlers: clear first, then refresh.
  // A document bubble listener would invalidate that newly started refresh.
  for (const id of ["contract", "draft-id", "file-milestone", "file-sha"])
    root.getElementById(id)?.addEventListener("input", clear);
  async function refresh() {
    const current = generation;
    const b = binding();
    const files = await apiRequest(
      `/api/files?kind=${b.kind}&resourceId=${encodeURIComponent(b.resourceId)}`
    );
    if (retired || current !== generation) return;
    el("file-list").replaceChildren();
    if (!files.length)
      el("file-list").textContent = "暂无文件，请乙方选择 ZIP 上传。";
    for (const file of files.filter(
      (f: any) => b.kind !== "artifact" || f.milestone_id === b.milestoneId
    )) {
      const li = root.createElement("li");
      li.textContent = `${file.name} · ${file.size} 字节 · SHA-256 ${
        file.checksum
      } · ${({
        quarantined: "隔离待扫描",
        scanning: "扫描中",
        clean: "文件已扫描",
        rejected: "扫描拒绝（感染、不可检查或超限），请检查归档后重新上传",
        unavailable:
          "扫描不可用（依赖缺失、超时、过载或执行失败），未放行，可重试"
      } as Record<string, string>)[file.scan_status] || file.scan_status} · ${
        file.scanner
      } · ${
        file.scanned_at
          ? new Date(file.scanned_at).toISOString()
          : "尚无扫描时间"
      }${file.simulated ? "（模拟扫描）" : ""} `;
      if (
        file.scan_status === "clean" &&
        !file.simulated &&
        file.scan_checksum === file.checksum
      ) {
        const button = root.createElement("button");
        button.textContent = "下载";
        button.onclick = () =>
          void run(async () => {
            if (active || retired) return;
            const current = generation;
            const headers = await sessionHeaders();
            if (retired || current !== generation) return;
            progress.value = 0;
            status.textContent = "正在下载";
            const blob = await new Promise<Blob>((resolve, reject) => {
              const xhr = (active = new XMLHttpRequest());
              xhr.open("GET", `/api/files/${file.id}/download`);
              xhr.responseType = "blob";
              for (const [key, value] of Object.entries(headers))
                xhr.setRequestHeader(key, value);
              xhr.onprogress = e => {
                if (e.lengthComputable)
                  progress.value = (e.loaded / e.total) * 100;
              };
              xhr.onload = () => {
                active = undefined;
                if (xhr.status === 200) resolve(xhr.response);
                else reject(new Error("下载被阻止，请刷新状态并检查权限"));
              };
              xhr.onerror = xhr.onabort = () => {
                active = undefined;
                reject(new Error("下载中断"));
              };
              xhr.send();
            });
            if (retired || current !== generation) return;
            const url = URL.createObjectURL(blob);
            const link = root.createElement("a");
            link.href = url;
            link.download = file.name;
            link.click();
            URL.revokeObjectURL(url);
            status.textContent = "下载完成";
          });
        li.append(button);
      } else li.append("阻塞：尚未通过扫描，不能下载或用于交付");
      if (
        ["unavailable", "quarantined", "scanning"].includes(file.scan_status)
      ) {
        const retry = root.createElement("button");
        retry.textContent = "重试扫描";
        retry.onclick = () =>
          void run(async () => {
            await apiRequest(`/api/files/${file.id}/scan`, "POST");
            await refresh();
          });
        li.append(retry);
      }
      el("file-list").append(li);
    }
  }
  async function run(work: () => Promise<void>) {
    try {
      if (retired) return;
      await work();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "文件操作失败";
    }
  }
  el("file-refresh").onclick = () => void run(refresh);
  el("file-upload").onclick = () =>
    void run(async () => {
      if (active || retired) return;
      const current = generation;
      const file = (el("private-file") as HTMLInputElement).files?.[0];
      if (!file) throw new Error("请选择文件");
      const b = binding();
      if (b.kind === "artifact" && !file.name.toLowerCase().endsWith(".zip"))
        throw new Error("交付请选择 ZIP 压缩包");
      if (file.size > 10485760)
        throw new Error("文件超过 10 MiB，请缩小 ZIP 后重试");
      const encoded = JSON.stringify(b);
      if (!pending || pending.file !== file || pending.binding !== encoded)
        pending = { file, binding: encoded, key: crypto.randomUUID() };
      const headers = await sessionHeaders();
      if (retired || current !== generation || active) return;
      progress.value = 0;
      status.textContent = "正在上传";
      await new Promise<void>((resolve, reject) => {
        const xhr = (active = new XMLHttpRequest());
        xhr.open("POST", "/api/files");
        for (const [key, value] of Object.entries(headers))
          xhr.setRequestHeader(key, value);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader(
          "X-File-Metadata",
          encodeURIComponent(
            JSON.stringify({
              ...b,
              name: file.name,
              mime:
                types[
                  file.name
                    .split(".")
                    .pop()!
                    .toLowerCase()
                ] || "",
              requestKey: pending!.key
            })
          )
        );
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) progress.value = (e.loaded / e.total) * 100;
        };
        xhr.onload = () => {
          active = undefined;
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            let code = "";
            try {
              code = JSON.parse(xhr.responseText).error.code;
            } catch {}
            reject(
              new Error(
                xhr.status === 413
                  ? "上传超限，请缩小 ZIP 后重试"
                  : xhr.status === 403
                  ? "上传权限已失效或被撤销，请联系甲方授予本合同上传权限后重试"
                  : `上传失败：${code}。请检查 ZIP 格式、合同是否生效，再刷新重试`
              )
            );
          }
        };
        xhr.onerror = xhr.onabort = () => {
          active = undefined;
          reject(new Error("上传中断，可重试同一文件"));
        };
        xhr.send(file);
      });
      if (retired || current !== generation) return;
      status.textContent =
        "字节已保存；请查看下方扫描结果。放行后刷新可提交 ZIP。";
      await refresh();
    });
}
