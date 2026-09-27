import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type { ReportEntry } from "../sync/executor";
import type { SyncAction, SyncPlan } from "../sync/types";
import { ACTION_LABELS } from "../sync/types";
import { renderFormatWarnings } from "./format-warnings";

export class ReportModal extends Modal {
  constructor(
    app: App,
    private readonly plan: SyncPlan,
    private readonly report: ReportEntry[],
    private readonly executed: boolean,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.executed ? "飞书同步结果" : "飞书同步计划（未执行）" });

    const failed = this.report.filter((entry) => !entry.ok);
    const conflicts = this.report.filter((entry) => entry.action === "conflict");
    const changed = this.report.filter((entry) => entry.ok && isChange(entry.action));

    const summary = contentEl.createEl("div", { cls: "feishu-sync-summary" });
    summary.createEl("div", { text: `变更 ${changed.length} 项 · 冲突 ${conflicts.length} 项 · 失败 ${failed.length} 项` });
    const planCounts = Object.entries(this.plan.counts)
      .filter(([action, count]) => action !== "skip" && count > 0)
      .map(([action, count]) => `${ACTION_LABELS[action as SyncAction] ?? action} ${count}`)
      .join(" · ");
    if (planCounts) {
      summary.createEl("div", { cls: "feishu-sync-reason", text: `本次计划：${planCounts}` });
    }

    renderFormatWarnings(contentEl, this.plan);
    renderSection(contentEl, "冲突副本（本地与远端均未改动，副本在 .obsidian/feishu-sync/conflicts/）", conflicts, true);
    renderSection(contentEl, "已执行", changed, false);
    renderSection(contentEl, "需要注意（未自动处理）", this.report.filter((entry) => !isChange(entry.action) && entry.action !== "conflict"), false);
    renderSection(contentEl, "失败", failed, false);

    new Setting(contentEl).addButton((button) => button.setButtonText("关闭").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function isChange(action: SyncAction): boolean {
  return ["push", "create-remote", "pull", "create-local", "link", "delete-remote", "delete-local"].includes(action);
}

function renderSection(container: HTMLElement, title: string, entries: ReportEntry[], isConflict: boolean): void {
  if (entries.length === 0) return;
  const section = container.createEl("div", { cls: "feishu-sync-section" });
  section.createEl("h4", { text: `${title}（${entries.length}）` });
  const list = section.createEl("div", { cls: "feishu-sync-list" });
  for (const entry of entries.slice(0, 300)) {
    const row = list.createEl("div", { cls: "feishu-sync-plan-item" });
    const badge = row.createEl("span", {
      cls: `feishu-sync-badge is-${isConflict ? "conflict" : entry.ok ? "push" : "conflict"}`,
      text: entry.ok ? (ACTION_LABELS[entry.action] ?? entry.action) : "失败",
    });
    badge.setAttr("title", entry.action);
    row.createEl("span", { cls: "feishu-sync-path", text: entry.relPath });
    if (entry.copyPath) row.createEl("span", { cls: "feishu-sync-reason", text: `副本：${entry.copyPath}` });
    if (entry.message) row.createEl("span", { cls: "feishu-sync-reason", text: entry.message });
  }
  if (entries.length > 300) {
    list.createEl("div", { text: `…还有 ${entries.length - 300} 项`, cls: "feishu-sync-reason" });
  }
}
