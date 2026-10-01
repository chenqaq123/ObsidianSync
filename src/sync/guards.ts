import { createHash } from "crypto";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { PluginSettings, SyncPlan, SyncModeSetting } from "./types";
import { emptyState, summarize } from "./types";
import type { SyncMode } from "./engine";
import { assertSafeVaultPath } from "./scanner";
import { walkWikiTree } from "../feishu/wiki";
import type { FeishuClient } from "../feishu/client";

export async function assertRemoteAbsent(client: FeishuClient, spaceId: string, rootNodeToken: string | undefined, token: string | undefined): Promise<void> {
  if (!token) throw new Error("缺少原有远端映射，未删除本地笔记");
  const entries = await walkWikiTree(client, spaceId, rootNodeToken);
  if (entries.some(entry => entry.objToken === token)) {
    throw new Error("远端笔记在预览后已恢复，未删除本地，请重新同步");
  }
}

/** A preview belongs to one configuration and one generation of the mapping table. */
export function planFingerprint(settings: PluginSettings): string {
  const { state, userTokens: _tokens, debugLog: _debug, autoSyncMinutes: _timer, showPlanBeforeSync: _preview, ...config } = settings;
  const { lastSyncAt: _lastRun, ...mappings } = state;
  return createHash("sha256").update(JSON.stringify([config, mappings])).digest("hex");
}

export function validateSettings(settings: PluginSettings): void {
  assertSafeVaultPath(settings.attachmentFolder);
  if (settings.attachmentFolder.startsWith(".obsidian") || settings.attachmentFolder.startsWith(".trash")) {
    throw new Error("附件目录不能放在 .obsidian 或 .trash 中");
  }
  if (settings.folderMode === "flat" && (!settings.flatSeparator || /[\\/:\x00-\x1f]/.test(settings.flatSeparator))) {
    throw new Error("扁平分隔符不能为空，也不能包含路径分隔符");
  }
  if (/\/wiki\//i.test(settings.spaceId)) throw new Error("space_id 需要知识空间 ID；请用「拉取列表」选择，页面链接填入同步根节点");
}

export function validateLocalPaths(paths: Iterable<string>, settings: PluginSettings): void {
  for (const path of paths) {
    assertSafeVaultPath(path);
    if (settings.folderMode === "flat" && path.includes(settings.flatSeparator)) {
      throw new Error(`笔记路径包含扁平分隔符 ${settings.flatSeparator}，无法无歧义还原：${path}；请使用镜像目录模式`);
    }
  }
}

export function assertPlanCurrent(plan: SyncPlan, settings: PluginSettings): void {
  if (plan.settingsFingerprint !== planFingerprint(settings)) {
    throw new Error("预览后同步设置或映射状态发生变化，请重新预览同步计划");
  }
}

export function prepareTarget(settings: PluginSettings, spaceId: string, rootNodeToken: string, syncMode: SyncModeSetting): boolean {
  const previous = settings.state.target;
  const changed = !!previous && (previous.spaceId !== spaceId || previous.rootNodeToken !== rootNodeToken ||
    (previous.syncMode ?? "md") !== syncMode ||
    (previous.folderMode !== undefined && previous.folderMode !== settings.folderMode) ||
    (previous.flatSeparator !== undefined && previous.flatSeparator !== settings.flatSeparator) ||
    (previous.rootPageTitle !== undefined && previous.rootPageTitle !== settings.rootPageTitle));
  if (changed) settings.state = emptyState();
  settings.state.target = { spaceId, rootNodeToken, syncMode, folderMode: settings.folderMode,
    flatSeparator: settings.flatSeparator, rootPageTitle: settings.rootPageTitle };
  return changed;
}

export function filterPlan(plan: SyncPlan, mode: SyncMode): SyncPlan {
  if (mode === "both") return plan;
  const items = plan.items.filter(entry => mode === "pull"
    ? !["push", "create-remote", "delete-remote"].includes(entry.action)
    : !["pull", "create-local", "delete-local"].includes(entry.action));
  return { ...plan, items, counts: summarize(items) };
}

export async function isEditorDirty(app: App, relPath: string): Promise<boolean> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as unknown as { file?: { path: string }; editor?: { getValue(): string } };
    if (view?.file?.path !== relPath || !view.editor) continue;
    const file = app.vault.getAbstractFileByPath(relPath);
    const disk = file instanceof TFile ? await app.vault.read(file) : "";
    if (view.editor.getValue() !== disk) return true;
  }
  return false;
}

export function deferDeletes(plan: SyncPlan, allowDeletes = true): SyncPlan {
  if (allowDeletes) return plan;
  const items = plan.items.map(entry => entry.action === "delete-local" || entry.action === "delete-remote"
    ? { ...entry, action: entry.action === "delete-local" ? "remote-deleted" as const : "local-deleted" as const,
        reason: "删除等待手动同步确认，定时同步未执行删除" }
    : entry);
  return { ...plan, items, counts: summarize(items) };
}
