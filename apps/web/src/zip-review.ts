import { apiRequest } from "./client.js";

export function renderZipReview() {
  return `<section id="zip-review"><h2>交付版本与验收</h2><p>按所选里程碑查看。下载后核对文件 SHA-256；乙方说明不是平台测试结论。</p><div id="zip-history"></div><form id="zip-review-form" hidden><label>处理方式<select id="zip-decision"><option value="changes_requested">要求修改</option><option value="accepted">确认验收</option></select></label><label>返工原因 / 验收依据<textarea id="zip-reason" required maxlength="10000"></textarea></label><label><input id="zip-confirm" type="checkbox" required>确认处理下方明确标识的当前版本</label><p id="zip-target"></p><button>确认处理当前版本</button></form><button id="zip-complete" hidden>全部已验收，确认完成合同（不付款或部署）</button><p id="zip-review-status" role="status"></p></section>`;
}
export function mountZipReview(
  root: Document,
  contract: () => string,
  milestone: () => string,
  party: () => string = () => "buyer",
  onSaved?: (message: string) => Promise<void>
) {
  if (!root.getElementById("zip-review"))
    return { refresh: async () => {}, clear: () => {} };
  const el = (id: string) => root.getElementById(id)!;
  const value = (id: string) => (el(id) as HTMLInputElement).value;
  let generation = 0;
  let snapshot: any;
  let target: any;
  let busy = false;
  function clear() {
    generation++;
    el("zip-review-status").textContent = "";
    snapshot = target = undefined;
    el("zip-history").replaceChildren();
    el("zip-review-form").hidden = true;
    el("zip-complete").hidden = true;
    el("zip-target").textContent = "";
    (el("zip-confirm") as HTMLInputElement).checked = false;
  }
  async function refresh() {
    clear();
    const current = generation,
      id = contract(),
      selected = milestone();
    const [data, files] = await Promise.all([
      apiRequest(`/api/contracts/${encodeURIComponent(id)}`),
      apiRequest(
        `/api/files?kind=artifact&resourceId=${encodeURIComponent(id)}`
      )
    ]);
    if (current !== generation || id !== contract() || selected !== milestone())
      return;
    snapshot = data;
    const m = data.milestones.find((m: any) => m.id === selected);
    const versions = data.zipDeliveries.filter(
      (d: any) => d.milestone_id === selected
    );
    target = versions.at(-1);
    if (!versions.length)
      el("zip-history").textContent =
        "此里程碑尚无 ZIP 提交。乙方上传并通过扫描后提交。";
    for (const d of [...versions].reverse()) {
      const file = files.find((f: any) => f.id === d.file_id);
      const row = root.createElement("article");
      const title = root.createElement("h3");
      title.textContent = `交付第 ${d.delivery_version} 版 · ${
        d.id === target.id
          ? m.status === "submitted"
            ? "当前待验收"
            : m.status === "accepted"
            ? "甲方已验收"
            : "当前版本 / 已要求修改"
          : "旧版本（仅供查看）"
      }`;
      const detail = root.createElement("p");
      detail.textContent = `${file?.name || "文件不可访问"} · ${file?.size ??
        "未知"} 字节 · ${new Date(d.created_at).toLocaleString()} · SHA-256 ${
        d.checksum
      } · 扫描：${file?.scan_status || "未知"}`;
      const notes = root.createElement("pre");
      notes.textContent = `交付说明：${d.summary}\n运行方法：${d.instructions}\n已知问题：${d.known_issues}`;
      row.append(title, detail, notes);
      if (
        file?.scan_status === "clean" &&
        !file.simulated &&
        file.scan_checksum === d.checksum
      ) {
        const download = root.createElement("a");
        download.href = `/api/files/${encodeURIComponent(d.file_id)}/download`;
        download.textContent = `下载第 ${d.delivery_version} 版 ZIP：${file.name}`;
        row.append(download);
      } else {
        const blocked = root.createElement("p");
        blocked.textContent =
          "扫描未放行或文件不可访问，不能下载或验收；请刷新文件状态或联系甲方检查权限。";
        row.append(blocked);
      }
      for (const event of data.events.filter(
        (e: any) => e.payload.deliveryId === d.id
      )) {
        const reason = root.createElement("p");
        reason.textContent = `${
          event.payload.to === "changes_requested" ? "修改请求" : "验收记录"
        }：${event.payload.reason.detail}`;
        row.append(reason);
      }
      el("zip-history").append(row);
    }
    el("zip-review-form").hidden = !(
      party() === "buyer" &&
      data.status === "active" &&
      m?.status === "submitted" &&
      target
    );
    el("zip-target").textContent = target
      ? `本次处理：第 ${target.delivery_version} 版 · SHA-256 ${target.checksum}`
      : "";
    const milestones = data.milestones.filter(
      (m: any) => m.version === data.version
    );
    el("zip-complete").hidden = !(
      party() === "buyer" &&
      data.status === "active" &&
      milestones.length > 0 &&
      milestones.every((m: any) => m.status === "accepted")
    );
  }
  async function command(complete = false) {
    if (busy || !snapshot || (complete && el("zip-complete").hidden)) return;
    busy = true;
    const current = generation;
    let feedbackGeneration = current;
    let saved = false;
    (el("zip-complete") as HTMLButtonElement).disabled = true;
    el("zip-review-status").textContent = "正在保存…";
    try {
      await apiRequest(
        `/api/contracts/${encodeURIComponent(snapshot.id)}/commands`,
        "POST",
        {
          action: complete ? "transition" : "milestone",
          version: snapshot.version,
          revision: snapshot.revision,
          requestKey: crypto.randomUUID(),
          confirmed:
            complete || (el("zip-confirm") as HTMLInputElement).checked,
          milestoneId: milestone(),
          deliveryId: target?.id,
          to: complete ? "completed" : value("zip-decision"),
          reason: {
            code: complete ? "complete" : "manual_review",
            detail: complete
              ? "全部里程碑已人工验收，确认完成合同"
              : value("zip-reason")
          }
        }
      );
      saved = true;
      if (current !== generation) return;
      const message = complete
        ? "合同已完成；未付款或部署。"
        : "验收处理已保存。";
      if (onSaved) await onSaved(message);
      else {
        const next = generation + 1;
        feedbackGeneration = next;
        await refresh();
        if (generation === next) el("zip-review-status").textContent = message;
      }
    } catch (e) {
      if (feedbackGeneration === generation)
        el("zip-review-status").textContent = saved
          ? "操作已保存，但刷新失败，请读取交付证据查看最新状态。"
          : `操作未完成：${String(
              e
            )}。请刷新工作区、重新下载核对当前版本后确认；权限失效请联系甲方重新授权。`;
    } finally {
      busy = false;
      (el("zip-complete") as HTMLButtonElement).disabled = false;
    }
  }
  el("zip-review-form").addEventListener("submit", e => {
    e.preventDefault();
    void command();
  });
  el("zip-complete").addEventListener("click", () => void command(true));
  return { refresh, clear };
}
