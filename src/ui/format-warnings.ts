import type { SyncPlan } from "../sync/types";

export function renderFormatWarnings(container: HTMLElement, plan: SyncPlan): void {
  if (!plan.warnings?.length) return;
  const section = container.createEl("div", { cls: "feishu-sync-section" });
  section.createEl("h4", { text: `原稿格式提示（${plan.warnings.length}）` });
  for (const warning of plan.warnings.slice(0, 100)) {
    section.createEl("div", { cls: "feishu-sync-reason", text: `${warning.relPath}：${warning.message}` });
  }
  if (plan.warnings.length > 100) section.createEl("div", { text: "仅显示前 100 条格式提示" });
}
