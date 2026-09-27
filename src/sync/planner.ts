import type { FileRecord, LocalNote, PlanItem, RemoteNote, SyncPlan, SyncState } from "./types";
import { dirnameOf, summarize } from "./types";

export interface PlannerInput {
  state: SyncState;
  local: Map<string, LocalNote>;
  remote: Map<string, RemoteNote>;
  isExcluded: (relPath: string) => boolean;
  hashLocal: (relPath: string) => Promise<string>;
  hashRemote: (fileToken: string) => Promise<string>;
  recreateRemoteIfDeleted: boolean;
  propagateLocalDelete: boolean;
  propagateRemoteDelete: boolean;
}

function item(relPath: string, action: PlanItem["action"], reason?: string, extra: Partial<PlanItem> = {}): PlanItem {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
}

function remoteFields(remote: RemoteNote): Partial<PlanItem> {
  return {
    remoteTitle: remote.entry.title,
    fileToken: remote.entry.objToken,
    nodeToken: remote.entry.nodeToken,
    remoteModifiedTime: remote.modifiedTime,
  };
}

function conflictItem(
  relPath: string,
  state: SyncState,
  reason: string,
  extra: Partial<PlanItem>,
  localHash: string,
  remoteHash: string,
): PlanItem {
  const previous = state.conflicts[relPath];
  const duplicate = !!previous && previous.remoteHash === remoteHash && previous.localHash === localHash;
  return item(relPath, "conflict", duplicate ? "与上次相同的冲突，未重复生成副本" : reason, {
    ...extra,
    localHash,
    remoteHash,
    duplicateConflict: duplicate,
  });
}

export async function buildPlan(input: PlannerInput): Promise<SyncPlan> {
  const { state, local, remote } = input;
  const items: PlanItem[] = [];

  const relPaths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(state.records)]);

  for (const relPath of Array.from(relPaths).sort()) {
    if (input.isExcluded(relPath)) continue;

    const localNote = local.get(relPath);
    const remoteNote = remote.get(relPath);
    const record: FileRecord | undefined = state.records[relPath];

    if (!record) {
      if (localNote && remoteNote) {
        if (localNote.size === 0) {
          items.push(item(relPath, "empty-local", "空文件不会被上传（飞书不接受 0 字节 Markdown）", remoteFields(remoteNote)));
          continue;
        }
        const [localHash, remoteHash] = await Promise.all([
          input.hashLocal(relPath),
          input.hashRemote(remoteNote.entry.objToken),
        ]);
        if (localHash === remoteHash) {
          items.push(item(relPath, "link", "两边内容一致，只建立映射", { ...remoteFields(remoteNote), localHash, remoteHash }));
        } else {
          items.push(
            conflictItem(relPath, state, "首次对接：同名文件两边内容不同，已保留双方", remoteFields(remoteNote), localHash, remoteHash),
          );
        }
        continue;
      }
      if (localNote) {
        if (localNote.size === 0) {
          items.push(item(relPath, "empty-local", "空文件不会被上传（飞书不接受 0 字节 Markdown）"));
        } else {
          items.push(item(relPath, "create-remote"));
        }
        continue;
      }
      if (remoteNote) {
        items.push(item(relPath, "create-local", undefined, remoteFields(remoteNote)));
      }
      continue;
    }
    if (!localNote && !remoteNote) {
      items.push(item(relPath, "forget", "两边都已不存在，清理映射"));
      continue;
    }

    if (!localNote) {
      if (!remoteNote) {
        items.push(item(relPath, "forget", "两边都已不存在，清理映射"));
        continue;
      }
      const remoteState = await checkRemoteChanged(input, record, remoteNote);
      if (remoteState.changed) {
        items.push(
          conflictItem(
            relPath,
            state,
            "本地已删除、远端被修改：为避免丢内容，未自动处理",
            { ...remoteFields(remoteNote), fileToken: record.fileToken },
            "",
            remoteState.hash ?? "",
          ),
        );
      } else if (input.propagateLocalDelete) {
        items.push(
          item(relPath, "delete-remote", "本地已删除，按设置删除远端（进飞书回收站，可恢复）", {
            ...remoteFields(remoteNote),
            fileToken: record.fileToken,
          }),
        );
      } else {
        items.push(item(relPath, "local-deleted", "本地已删除、远端未变（未自动删除远端）", remoteFields(remoteNote)));
      }
      continue;
    }

    if (!remoteNote) {
      const localChanged = await isLocalChanged(input, record, localNote);
      if (!localChanged) {
        if (input.propagateRemoteDelete) {
          items.push(item(relPath, "delete-local", "远端已删除且本地未变，按设置把本地笔记移进 .trash", {
            fileToken: record.fileToken,
            localSize: localNote.size,
            localMtime: localNote.mtime,
          }));
        } else {
          items.push(item(relPath, "remote-deleted", "远端已删除、本地未变（未自动删除本地）"));
        }
      } else if (input.recreateRemoteIfDeleted) {
        items.push(item(relPath, "create-remote", "远端已删除但本地有修改，按设置重新上传"));
      } else {
        items.push(item(relPath, "remote-deleted", "远端已删除、本地有修改：为避免误恢复，未自动重建"));
      }
      continue;
    }

    if (localNote.size === 0) {
      items.push(item(relPath, "empty-local", "空文件不参与同步", remoteFields(remoteNote)));
      continue;
    }

    const localChanged = await isLocalChanged(input, record, localNote);
    const remoteState = await checkRemoteChanged(input, record, remoteNote);
    const remoteChanged = remoteState.changed;

    if (!localChanged && !remoteChanged) {
      items.push(item(relPath, "skip"));
      continue;
    }
    if (localChanged && !remoteChanged) {
      items.push(item(relPath, "push", undefined, remoteFields(remoteNote)));
      continue;
    }
    if (!localChanged && remoteChanged) {
      items.push(item(relPath, "pull", undefined, { ...remoteFields(remoteNote), localSize: localNote.size, localMtime: localNote.mtime }));
      continue;
    }

    const [localHash, remoteHash] = await Promise.all([input.hashLocal(relPath), input.hashRemote(remoteNote.entry.objToken)]);
    if (localHash === remoteHash) {
      items.push(item(relPath, "link", "两边内容一致，只更新基线", { ...remoteFields(remoteNote), localHash, remoteHash }));
      continue;
    }
    if (localHash === record.baseHash) {
      items.push(
        item(relPath, "pull", "本地内容未变，远端才是新版本", {
          ...remoteFields(remoteNote),
          localHash,
          remoteHash,
          localSize: localNote.size,
          localMtime: localNote.mtime,
        }),
      );
      continue;
    }
    if (remoteHash === record.baseHash) {
      items.push(item(relPath, "push", "远端内容未变，本地才是新版本", { ...remoteFields(remoteNote), localHash, remoteHash }));
      continue;
    }
    items.push(
      conflictItem(relPath, state, "两边都改过且内容不同，已保留双方", remoteFields(remoteNote), localHash, remoteHash),
    );
  }

  return {
    items,
    counts: summarize(items),
    localNoteCount: local.size,
    remoteNoteCount: remote.size,
  };
}

async function isLocalChanged(input: PlannerInput, record: FileRecord, localNote: LocalNote): Promise<boolean> {
  if (record.localSize === localNote.size && record.localMtime === localNote.mtime && record.baseHash) {
    return false;
  }
  const hash = await input.hashLocal(localNote.relPath);
  return hash !== record.baseHash;
}

async function checkRemoteChanged(
  input: PlannerInput,
  record: FileRecord,
  remoteNote: RemoteNote,
): Promise<{ changed: boolean; hash?: string }> {
  if (record.remoteModifiedTime && remoteNote.modifiedTime && record.remoteModifiedTime === remoteNote.modifiedTime) {
    return { changed: false };
  }
  const hash = await input.hashRemote(remoteNote.entry.objToken);
  return { changed: hash !== record.baseHash, hash };
}
