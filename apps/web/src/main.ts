export function validateGoal(value: string): string | null {
  return value.trim() ? null : "请填写需求目标。";
}
export function mountInteractions(root: Document, reload: () => void): void {
  root
    .querySelector<HTMLButtonElement>("[data-retry]")
    ?.addEventListener("click", reload);
  const form = root.querySelector<HTMLFormElement>("[data-demo-form]");
  form?.addEventListener("submit", event => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#goal")!;
    const error = validateGoal(input.value);
    input.setAttribute("aria-invalid", String(!!error));
    root.querySelector<HTMLElement>("#goal-error")!.textContent = error || "";
    root.querySelector<HTMLElement>("[data-form-result]")!.textContent = error
      ? ""
      : "检查通过。此为演示，未保存或发布。";
    const summary = root.querySelector<HTMLElement>("[data-form-summary]");
    if (summary) {
      summary.textContent = error
        ? "请检查表单：需求目标尚未填写。"
        : "表单检查通过，未保存或发布。";
      summary.setAttribute("role", error ? "alert" : "status");
    }
    if (error) input.focus();
  });
}
if (typeof document !== "undefined")
  mountInteractions(document, () => window.location.reload());
