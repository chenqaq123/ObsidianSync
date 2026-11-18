import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { PlanItem, SyncState } from "./types";
import { dirnameOf } from "./types";

/** 计划项构造：md / doc 两套 planner 共用。 */
export function item(relPath: string, action: PlanItem["action"], reason?: string, extra: Partial<PlanItem> = {}): PlanItem {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
}

/** 旧版冲突记录仍用于识别同一冲突；手动合并不再生成副本。 */
export function conflictItem(
  relPath: string,
  state: SyncState,
  reason: string,
  extra: Partial<PlanItem>,
  localHash: string,
  remoteHash: string,
): PlanItem {
  const previous = state.conflicts[relPath];
  const duplicate = !!previous && previous.remoteHash === remoteHash && previous.localHash === localHash;
  return item(relPath, "conflict", duplicate ? "同一冲突仍未处理，等待手动合并" : reason, {
    ...extra,
    localHash,
    remoteHash,
    duplicateConflict: duplicate,
  });
}

export function existsLocally(app: App, relPath: string): boolean {
  return app.vault.getAbstractFileByPath(relPath) instanceof TFile;
}
