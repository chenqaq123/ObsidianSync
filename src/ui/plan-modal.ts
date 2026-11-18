import type { App } from "obsidian";
import { Modal, Setting, setIcon } from "obsidian";
import type { ItemChoice, PlanDecision } from "../sync/engine-base";
import type { PlanItem, SyncAction, SyncPlan } from "../sync/types";
import { renderFormatWarnings } from "./format-warnings";

type SectionKey = "upload" | "download" | "conflict" | "other";

/** 三类主分组始终保留区域（空列表也不隐藏）；其余分组仅在出现时展示。 */
const SECTIONS: { key: SectionKey; title: string; actions: SyncAction[]; selectable: boolean; always?: boolean }[] = [
  { key: "upload", title: "上传到飞书", actions: ["push", "create-remote"], selectable: true, always: true },
  { key: "download", title: "从飞书下载", actions: ["pull", "create-local"], selectable: true, always: true },
  { key: "conflict", title: "存在冲突", actions: ["conflict"], selectable: true, always: true },
  { key: "other", title: "删除远端", actions: ["delete-remote"], selectable: false },
  { key: "other", title: "删除本地", actions: ["delete-local"], selectable: false },
  { key: "other", title: "建立映射", actions: ["link"], selectable: false },
  { key: "other", title: "仅提示", actions: ["local-deleted", "remote-deleted", "empty-local", "dirty-editor", "forget"], selectable: false },
];

const SUMMARY_FAMILIES: { label: string; actions: SyncAction[]; cls: string }[] = [
  { label: "上传", actions: ["push", "create-remote"], cls: "is-push" },
  { label: "下载", actions: ["pull", "create-local"], cls: "is-pull" },
  { label: "冲突", actions: ["conflict"], cls: "is-conflict" },
  { label: "删远端", actions: ["delete-remote"], cls: "is-delete" },
  { label: "删本地", actions: ["delete-local"], cls: "is-delete" },
  { label: "建映射", actions: ["link"], cls: "is-other" },
];

/** 计划内的动作名称：上传就是上传，不再称「上传覆盖」。 */
const PLAN_LABELS: Record<SyncAction, string> = {
  skip: "已同步",
  push: "上传",
  "create-remote": "新建上传",
  pull: "下载",
  "create-local": "新建下载",
  link: "建立映射",
  conflict: "冲突",
  "delete-remote": "删除远端",
  "delete-local": "删除本地",
  "local-deleted": "本地已删除",
  "remote-deleted": "远端已删除",
  "empty-local": "空文件",
  "dirty-editor": "编辑中",
  forget: "清理映射",
};

const CONFLICT_LABELS: Record<ItemChoice, string> = {
  push: "上传覆盖",
  pull: "下载覆盖",
  skip: "跳过",
};

const RENDER_CAP = 500;

export class PlanModal extends Modal {
  private decided = false;
  /** 仅为「偏离计划」的项记录动作：普通文件取消勾选 = skip，冲突选择上传/下载。 */
  private readonly actions: Record<string, ItemChoice> = {};
  /** 冲突勾选集合：只有冲突需要选中后再统一指定处理方式。 */
  private readonly conflictSelected = new Set<string>();
  private readonly conflictEntries: PlanItem[] = [];
  private readonly rowRefreshers = new Map<string, () => void>();
  private readonly groupRefreshers: (() => void)[] = [];
  private readonly bulkButtons = new Map<ItemChoice | "", HTMLButtonElement>();
  private conflictCountEl: HTMLElement | null = null;
  private executeButton: { setButtonText(text: string): unknown } | null = null;

  constructor(
    app: App,
    private readonly plan: SyncPlan,
    private readonly resolve: (decision: PlanDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("feishu-sync-modal");
    const { contentEl } = this;
    contentEl.empty();
    this.conflictEntries.length = 0;
    this.rowRefreshers.clear();
    this.groupRefreshers.length = 0;
    this.bulkButtons.clear();

    const heading = contentEl.createEl("div", { cls: "feishu-sync-heading" });
    const headingIcon = heading.createEl("div", { cls: "feishu-sync-heading-icon" });
    setIcon(headingIcon, "refresh-cw");
    const headingText = heading.createEl("div", { cls: "feishu-sync-heading-text" });
    headingText.createEl("h2", { cls: "feishu-sync-title", text: "同步计划" });
    headingText.createEl("div", {
      cls: "feishu-sync-subtitle",
      text: `本地 ${this.plan.localNoteCount} 篇 · 远端 ${this.plan.remoteNoteCount} 篇`,
    });

    const chips = contentEl.createEl("div", { cls: "feishu-sync-chips" });
    for (const family of SUMMARY_FAMILIES) {
      const count = family.actions.reduce((sum, action) => sum + (this.plan.counts[action] ?? 0), 0);
      if (count > 0) chips.createEl("span", { cls: `feishu-sync-chip ${family.cls}`, text: `${family.label} ${count}` });
    }
    const skipped = this.plan.counts.skip ?? 0;
    if (skipped > 0) chips.createEl("span", { cls: "feishu-sync-chip is-muted", text: `无变化 ${skipped}` });
    if (chips.childElementCount === 0) chips.createEl("span", { cls: "feishu-sync-chip is-muted", text: "没有待处理改动" });

    // 操作栏只服务于冲突；上传/下载通过各自区域的勾选决定做不做
    if ((this.plan.counts.conflict ?? 0) > 0) this.renderConflictToolbar(contentEl);
    renderFormatWarnings(contentEl, this.plan);

    const groups = contentEl.createEl("div", { cls: "feishu-sync-groups" });
    for (const section of SECTIONS) {
      const items = this.plan.items.filter((entry) => section.actions.includes(entry.action));
      if (items.length === 0 && !section.always) continue;
      this.renderSection(groups, section, items);
    }

    const footer = new Setting(contentEl);
    footer.settingEl.addClass("feishu-sync-footer");
    footer
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.decide("cancel");
          this.close();
        }),
      )
      .addButton((button) => {
        this.executeButton = button.setButtonText("执行同步").setCta().onClick(() => {
          const decision: PlanDecision = Object.keys(this.actions).length > 0
            ? { kind: "overrides", actions: { ...this.actions } }
            : "all";
          this.decide(decision);
          this.close();
        });
      });
    this.refreshAll();
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide("cancel");
  }

  /** 冲突处理：勾选冲突后可统一设为手动合并 / 上传 / 下载。 */
  private renderConflictToolbar(container: HTMLElement): void {
    const toolbar = container.createEl("div", { cls: "feishu-sync-toolbar" });

    const selectionLine = toolbar.createEl("div", { cls: "feishu-sync-toolbar-line" });
    this.conflictCountEl = selectionLine.createEl("span", { cls: "feishu-sync-selected-count" });
    const selectAll = selectionLine.createEl("button", { cls: "feishu-sync-text-button", text: "全选" });
    selectAll.addEventListener("click", () => {
      for (const entry of this.conflictEntries) this.conflictSelected.add(entry.relPath);
      this.refreshAll();
    });
    const clear = selectionLine.createEl("button", { cls: "feishu-sync-text-button", text: "清空" });
    clear.addEventListener("click", () => {
      this.conflictSelected.clear();
      this.refreshAll();
    });

    const actionLine = toolbar.createEl("div", { cls: "feishu-sync-toolbar-line feishu-sync-bulk-line" });
    actionLine.createEl("span", { cls: "feishu-sync-toolbar-label", text: "冲突处理方式" });
    const bulkDefinitions: { value: ItemChoice | ""; label: string; hint: string }[] = [
      { value: "", label: "手动合并", hint: "本地与远端都不改动，稍后手动整理" },
      { value: "push", label: "上传", hint: "用本地版本覆盖飞书远端" },
      { value: "pull", label: "下载", hint: "用飞书远端覆盖本地版本" },
    ];
    for (const definition of bulkDefinitions) {
      const button = actionLine.createEl("button", { cls: "feishu-sync-bulk-button", text: definition.label });
      button.title = definition.hint;
      button.addEventListener("click", () => this.applyConflictAction(definition.value));
      this.bulkButtons.set(definition.value, button);
    }
  }

  private renderSection(container: HTMLElement, section: (typeof SECTIONS)[number], items: PlanItem[]): void {
    const element = container.createEl("div", { cls: "feishu-sync-section" });
    const header = element.createEl("div", { cls: "feishu-sync-group-header" });

    if (section.selectable) {
      const checkbox = header.createEl("input", {
        cls: "feishu-sync-checkbox",
        attr: { type: "checkbox", "aria-label": `选择${section.title}全部文件` },
      });
      checkbox.addEventListener("change", () => {
        if (section.key === "conflict") {
          for (const entry of items) {
            if (checkbox.checked) this.conflictSelected.add(entry.relPath);
            else this.conflictSelected.delete(entry.relPath);
          }
        } else {
          for (const entry of items) {
            if (checkbox.checked) delete this.actions[entry.relPath];
            else this.actions[entry.relPath] = "skip";
          }
        }
        this.refreshAll();
      });
      this.groupRefreshers.push(() => {
        const checkedCount = items.filter((entry) =>
          section.key === "conflict"
            ? this.conflictSelected.has(entry.relPath)
            : this.actions[entry.relPath] !== "skip",
        ).length;
        checkbox.checked = items.length > 0 && checkedCount === items.length;
        checkbox.indeterminate = checkedCount > 0 && checkedCount < items.length;
      });
    }

    const name = header.createEl("div", { cls: "feishu-sync-group-name" });
    name.createEl("span", { cls: "feishu-sync-group-title", text: section.title });
    name.createEl("span", { cls: "feishu-sync-group-count", text: String(items.length) });

    const body = element.createEl("div", { cls: "feishu-sync-list" });
    for (const entry of items.slice(0, RENDER_CAP)) this.renderItem(body, section.key, entry);
    if (items.length > RENDER_CAP) {
      body.createEl("div", { text: `仅显示前 ${RENDER_CAP} 项，还有 ${items.length - RENDER_CAP} 项`, cls: "feishu-sync-more" });
    }
  }

  private renderItem(container: HTMLElement, sectionKey: SectionKey, entry: PlanItem): void {
    const selectable = sectionKey === "upload" || sectionKey === "download" || sectionKey === "conflict";
    const row = container.createEl(selectable ? "label" : "div", { cls: "feishu-sync-row" });
    if (!selectable) row.addClass("is-plain");

    let checkbox: HTMLInputElement | null = null;
    if (selectable) {
      checkbox = row.createEl("input", {
        cls: "feishu-sync-checkbox",
        attr: { type: "checkbox", "aria-label": sectionKey === "conflict" ? `选择冲突 ${entry.relPath}` : `包含 ${entry.relPath}` },
      });
      if (sectionKey === "conflict") {
        this.conflictEntries.push(entry);
        checkbox.addEventListener("change", () => {
          if (checkbox!.checked) this.conflictSelected.add(entry.relPath);
          else this.conflictSelected.delete(entry.relPath);
          this.refreshAll();
        });
      } else {
        // 上传/下载的勾选即「本次是否执行」，取消勾选等于跳过该文件
        checkbox.addEventListener("change", () => {
          if (checkbox!.checked) delete this.actions[entry.relPath];
          else this.actions[entry.relPath] = "skip";
          this.refreshAll();
        });
      }
    }

    row.createEl("span", {
      cls: `feishu-sync-badge is-${badgeClass(entry.action)}`,
      text: PLAN_LABELS[entry.action] ?? entry.action,
    });

    const path = row.createEl("span", {
      cls: "feishu-sync-path",
      title: entry.reason ? `${entry.relPath}\n${entry.reason}` : entry.relPath,
    });
    const slash = entry.relPath.lastIndexOf("/");
    if (slash >= 0) path.createEl("span", { cls: "feishu-sync-dir", text: entry.relPath.slice(0, slash + 1) });
    path.createEl("span", { cls: "feishu-sync-filename", text: entry.relPath.slice(slash + 1) });
    // 只有冲突会显示处理方式标签；上传/下载不做逐行标记
    const override = row.createEl("span", { cls: "feishu-sync-override" });

    if (selectable) {
      const refresh = (): void => {
        if (sectionKey === "conflict") {
          const value = this.actions[entry.relPath] ?? "";
          checkbox!.checked = this.conflictSelected.has(entry.relPath);
          row.toggleClass("is-selected", checkbox!.checked);
          override.setText(value ? CONFLICT_LABELS[value] : "");
          override.className = `feishu-sync-override${value ? ` is-${value}` : ""}`;
        } else {
          checkbox!.checked = this.actions[entry.relPath] !== "skip";
          row.toggleClass("is-skipped", !checkbox!.checked);
          override.setText("");
          override.className = "feishu-sync-override";
        }
      };
      this.rowRefreshers.set(entry.relPath, refresh);
      refresh();
    }
  }

  private applyConflictAction(value: ItemChoice | ""): void {
    if (this.conflictSelected.size === 0) return;
    for (const entry of this.conflictEntries) {
      if (!this.conflictSelected.has(entry.relPath)) continue;
      if (value) this.actions[entry.relPath] = value;
      else delete this.actions[entry.relPath];
    }
    this.refreshAll();
  }

  private refreshAll(): void {
    const conflictTotal = this.conflictEntries.length;
    const conflictSelectedCount = this.conflictEntries.filter((entry) => this.conflictSelected.has(entry.relPath)).length;
    const adjustedCount = Object.keys(this.actions).length;

    this.conflictCountEl?.setText(
      conflictTotal === 0 ? "没有冲突" : conflictSelectedCount > 0 ? `已选 ${conflictSelectedCount} 个冲突` : `共 ${conflictTotal} 个冲突，未选择`,
    );
    this.executeButton?.setButtonText(adjustedCount > 0 ? `执行同步 · ${adjustedCount} 项已调整` : "执行同步");

    for (const [choice, button] of this.bulkButtons) {
      button.disabled = conflictSelectedCount === 0;
      button.title = conflictSelectedCount === 0 ? "请先勾选冲突文件" : "";
      // 当前选中冲突的统一处理方式：与该按钮一致时高亮
      const active = conflictSelectedCount > 0 && this.selectedConflictsEvery((entry) =>
        (this.actions[entry.relPath] ?? "") === choice,
      );
      button.toggleClass("is-active", active);
    }
    for (const refresh of this.rowRefreshers.values()) refresh();
    for (const refresh of this.groupRefreshers) refresh();
  }

  private selectedConflictsEvery(predicate: (entry: PlanItem) => boolean): boolean {
    const selected = this.conflictEntries.filter((entry) => this.conflictSelected.has(entry.relPath));
    return selected.length > 0 && selected.every(predicate);
  }

  private decide(decision: PlanDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(decision);
  }
}

function badgeClass(action: SyncAction): string {
  if (action === "push" || action === "create-remote") return "push";
  if (action === "pull" || action === "create-local") return "pull";
  if (action === "conflict") return "conflict";
  if (action === "delete-remote" || action === "delete-local") return "delete";
  return "other";
}
