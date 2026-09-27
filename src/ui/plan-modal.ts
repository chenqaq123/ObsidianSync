import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type { PlanDecision } from "../sync/engine";
import type { PlanItem, SyncAction, SyncPlan } from "../sync/types";
import { ACTION_LABELS } from "../sync/types";
import { renderFormatWarnings } from "./format-warnings";

const GROUPS: { key: string; title: string; actions: SyncAction[] }[] = [
  { key: "push", title: "会上传到飞书", actions: ["push", "create-remote"] },
  { key: "pull", title: "会拉取到本地", actions: ["pull", "create-local"] },
  { key: "delete-remote", title: "会删除远端（进飞书回收站，可恢复）", actions: ["delete-remote"] },
  { key: "delete-local", title: "会删除本地文件（移入 .trash）", actions: ["delete-local"] },
  { key: "conflict", title: "冲突（保留双方，不自动覆盖）", actions: ["conflict"] },
  { key: "link", title: "只建立映射", actions: ["link"] },
  { key: "observe", title: "仅提示，不会改动任何一边", actions: ["local-deleted", "remote-deleted", "empty-local", "dirty-editor", "forget"] },
];

export class PlanModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly plan: SyncPlan,
    private readonly resolve: (decision: PlanDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "飞书同步计划" });

    const summary = contentEl.createEl("div", { cls: "feishu-sync-summary" });
    const counts = Object.entries(this.plan.counts)
      .filter(([action]) => action !== "skip")
      .map(([action, count]) => `${ACTION_LABELS[action as SyncAction] ?? action} ${count}`)
      .join(" · ");
    summary.createEl("div", {
      text: `本地 ${this.plan.localNoteCount} 篇 · 远端 ${this.plan.remoteNoteCount} 篇${counts ? ` · ${counts}` : " · 无待处理改动"}`,
    });
    const skipped = this.plan.counts.skip ?? 0;
    if (skipped > 0) {
      summary.createEl("div", { text: `已同步且无变化：${skipped} 篇`, cls: "feishu-sync-reason" });
    }

    renderFormatWarnings(contentEl, this.plan);
    for (const group of GROUPS) {
      const items = this.plan.items.filter((entry) => group.actions.includes(entry.action));
      if (items.length === 0) continue;
      const section = contentEl.createEl("div", { cls: "feishu-sync-section" });
      section.createEl("h4", { text: `${group.title}（${items.length}）` });
      const list = section.createEl("div", { cls: "feishu-sync-list" });
      for (const entry of items.slice(0, 200)) {
        renderItem(list, entry);
      }
      if (items.length > 200) {
        list.createEl("div", { text: `…还有 ${items.length - 200} 项`, cls: "feishu-sync-reason" });
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.decide("cancel");
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText("仅拉取（不推送）").onClick(() => {
          this.decide("pull-only");
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("执行全部")
          .setCta()
          .onClick(() => {
            this.decide("all");
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide("cancel");
  }

  private decide(decision: PlanDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(decision);
  }
}

function renderItem(container: HTMLElement, entry: PlanItem): void {
  const row = container.createEl("div", { cls: "feishu-sync-plan-item" });
  const badge = row.createEl("span", { cls: `feishu-sync-badge is-${badgeClass(entry.action)}`, text: ACTION_LABELS[entry.action] ?? entry.action });
  badge.setAttr("title", entry.action);
  row.createEl("span", { cls: "feishu-sync-path", text: entry.relPath });
  if (entry.reason) {
    row.createEl("span", { cls: "feishu-sync-reason", text: entry.reason });
  }
}

function badgeClass(action: SyncAction): string {
  if (action === "push" || action === "create-remote") return "push";
  if (action === "pull" || action === "create-local") return "pull";
  if (action === "conflict") return "conflict";
  if (action === "delete-remote" || action === "delete-local") return "delete";
  return "other";
}
