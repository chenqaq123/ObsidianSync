import type { RulesFile } from "../convert/rules";
import { applyRules } from "../convert/rules";
import type { WikiTreeEntry } from "../feishu/wiki";
import type { LocalNote, PlanItem, SyncPlan, SyncState } from "./types";
import { basenameOf, dirnameOf, joinPath, summarize } from "./types";

export interface DocRemoteNote {
  relPath: string;
  documentId: string;
  nodeToken: string;
  parentNodeToken?: string;
  title: string;
}

export interface DocRemoteContainer {
  nodeToken: string;
  title: string;
  parentNodeToken?: string;
}

export interface DocRemoteIndex {
  /** 候选笔记：标题即笔记名 */
  notes: Map<string, DocRemoteNote>;
  /** 容器：relDir -> 节点（含空间顶层/根容器） */
  containers: Map<string, DocRemoteContainer>;
  containerTitles: Set<string>;
  warnings: string[];
}

export interface DocIndexOptions {
  entries: WikiTreeEntry[];
  state: SyncState;
  folderMode: "nodes" | "flat";
  flatSeparator: string;
  rootContainerNode?: string;
  isExcluded: (relPath: string) => boolean;
}

/** 笔记名去掉 .md；扁平模式把目录编码进标题，与 md 模式的远端文件名约定一致。 */
export function documentTitleFor(
  relPath: string,
  settings: { folderMode: "nodes" | "flat"; flatSeparator: string },
): string {
  const name = basenameOf(relPath).replace(/\.md$/i, "");
  if (settings.folderMode !== "flat") return name;
  const dir = dirnameOf(relPath);
  if (!dir) return name;
  return `${dir.split("/").join(settings.flatSeparator)}${settings.flatSeparator}${name}`;
}

/** 文档标题与某个容器（往往是同名文件夹）撞名时加后缀，避免知识库里两个同名节点分不清。 */
export function uniqueDocumentTitle(title: string, taken: Set<string>): { title: string; renamed: boolean } {
  if (!taken.has(title)) return { title, renamed: false };
  let candidate = `${title} (note)`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${title} (note ${index})`;
    index += 1;
  }
  return { title: candidate, renamed: true };
}

function illegalSegments(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

function deriveRelPath(entry: WikiTreeEntry, options: DocIndexOptions, warnings: string[]): string | undefined {
  if (options.folderMode === "flat") {
    const relPath = `${entry.title.split(options.flatSeparator).join("/")}.md`;
    if (illegalSegments(relPath)) {
      warnings.push(`远端标题里的路径片段非法，已跳过：${entry.title}`);
      return undefined;
    }
    return relPath;
  }
  const relPath = joinPath(entry.relDir, `${entry.title.replace(/\.md$/i, "")}.md`);
  if (illegalSegments(relPath)) {
    warnings.push(`远端标题包含非法路径片段，已跳过：${entry.title}`);
    return undefined;
  }
  return relPath;
}

/**
 * 把 wiki 树里的 docx 节点分成容器与候选笔记。
 * 容器判定：在 state.folders 里（我们建过的目录节点），或者是树里某个节点的父节点
 * （知识库里"有子页面的页面"就是目录；状态被清空后也能靠这条认出目录，不会把目录当笔记拉下来）。
 */
export function buildDocRemoteIndex(options: DocIndexOptions): DocRemoteIndex {
  const warnings: string[] = [];
  const containerTokens = new Set<string>();
  for (const folder of Object.values(options.state.folders)) {
    if (folder.nodeToken) containerTokens.add(folder.nodeToken);
  }
  if (options.rootContainerNode) containerTokens.add(options.rootContainerNode);
  const parentTokens = new Set<string>();
  for (const entry of options.entries) {
    if (entry.parentNodeToken) parentTokens.add(entry.parentNodeToken);
  }
  for (const entry of options.entries) {
    if (entry.objType === "file") continue;
    if (containerTokens.has(entry.nodeToken) || parentTokens.has(entry.nodeToken)) containerTokens.add(entry.nodeToken);
  }

  const containers = new Map<string, DocRemoteContainer>();
  const containerTitles = new Set<string>();
  for (const entry of options.entries) {
    if (!containerTokens.has(entry.nodeToken)) continue;
    const relDir = entry.nodeToken === options.rootContainerNode ? "" : joinPath(entry.relDir, entry.title);
    if (options.folderMode === "nodes" && !containers.has(relDir)) {
      containers.set(relDir, { nodeToken: entry.nodeToken, title: entry.title, parentNodeToken: entry.parentNodeToken });
    }
    containerTitles.add(entry.title);
  }

  const knownDocumentPaths = new Map<string, string>();
  for (const [relPath, record] of Object.entries(options.state.docRecords)) {
    knownDocumentPaths.set(record.documentId, relPath);
  }

  const notes = new Map<string, DocRemoteNote>();
  const seenPaths = new Map<string, string>();
  for (const entry of options.entries) {
    if (entry.objType !== "docx" || containerTokens.has(entry.nodeToken)) continue;
    const relPath = knownDocumentPaths.get(entry.objToken) ?? deriveRelPath(entry, options, warnings);
    if (!relPath) continue;
    if (options.isExcluded(relPath)) continue;
    // macOS / Windows 的大小写不敏感与 NFC/NFD 差异会让两个不同标题落到同一个物理文件上
    const normalized = relPath.normalize("NFC").toLowerCase();
    const clash = seenPaths.get(normalized);
    if (clash === relPath) {
      warnings.push(`远端存在多个同名文档，只处理其中一个：${relPath}`);
      continue;
    }
    if (clash && clash !== relPath) {
      warnings.push(`远端存在仅大小写或 Unicode 形式不同的同名文档，已跳过其中一个：${relPath}（与 ${clash} 冲突）`);
      continue;
    }
    seenPaths.set(normalized, relPath);
    notes.set(relPath, {
      relPath,
      documentId: entry.objToken,
      nodeToken: entry.nodeToken,
      parentNodeToken: entry.parentNodeToken,
      title: entry.title,
    });
  }

  return { notes, containers, containerTitles, warnings };
}

export interface DocPlanCache {
  localText: Map<string, string>;
  localHash: Map<string, string>;
  fetched: Map<string, string>;
  fetchedHash: Map<string, string>;
  pulled: Map<string, string>;
  fetchCount: number;
}

export function createDocPlanCache(): DocPlanCache {
  return {
    localText: new Map(),
    localHash: new Map(),
    fetched: new Map(),
    fetchedHash: new Map(),
    pulled: new Map(),
    fetchCount: 0,
  };
}

export interface DocPlannerInput {
  state: SyncState;
  local: Map<string, LocalNote>;
  remote: DocRemoteIndex;
  settings: { folderMode: "nodes" | "flat"; flatSeparator: string };
  rules: RulesFile;
  isExcluded: (relPath: string) => boolean;
  readLocal: (relPath: string) => Promise<string>;
  hashText: (text: string) => Promise<string>;
  /** 取回形态（图片 URL 归一化后）的哈希，与执行期记基线时口径一致 */
  hashFetched: (text: string) => Promise<string>;
  fetchMarkdown: (documentId: string) => Promise<string>;
  recreateRemoteIfDeleted: boolean;
  propagateLocalDelete: boolean;
  propagateRemoteDelete: boolean;
  cache: DocPlanCache;
  /** 文档 id → 飞书返回的最后修改时间（Unix 秒字符串），接口失败时为空 Map */
  remoteModifiedTimes: Map<string, string>;
  /** 安全阀：忽略时间戳，每轮都取回全文校验 */
  verifyRemoteByContent: boolean;
  /** 强制重推：忽略基线，把本地有内容的笔记都判成 push */
  forcePush: boolean;
}

function item(relPath: string, action: PlanItem["action"], reason?: string, extra: Partial<PlanItem> = {}): PlanItem {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
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

export async function readLocalCached(input: DocPlannerInput, relPath: string): Promise<string> {
  const cached = input.cache.localText.get(relPath);
  if (cached !== undefined) return cached;
  const text = await input.readLocal(relPath);
  input.cache.localText.set(relPath, text);
  return text;
}

async function hashLocalCached(input: DocPlannerInput, relPath: string): Promise<string> {
  const cached = input.cache.localHash.get(relPath);
  if (cached !== undefined) return cached;
  const hash = await input.hashText(await readLocalCached(input, relPath));
  input.cache.localHash.set(relPath, hash);
  return hash;
}

export async function fetchCached(input: DocPlannerInput, documentId: string): Promise<string> {
  const cached = input.cache.fetched.get(documentId);
  if (cached !== undefined) return cached;
  input.cache.fetchCount += 1;
  const text = await input.fetchMarkdown(documentId);
  input.cache.fetched.set(documentId, text);
  return text;
}

/**
 * 远端是否变了：先用批量元数据的时间戳快路径判断，时间戳对得上就不取回；
 * 时间戳缺失/不一致/被安全阀关掉时才取回算哈希。
 */
async function remoteChangedState(
  input: DocPlannerInput,
  record: { baseRemoteHash: string; remoteModifiedTime?: string },
  documentId: string,
): Promise<{ changed: boolean; hash?: string; metaTime?: string }> {
  const metaTime = input.remoteModifiedTimes.get(documentId);
  if (!input.verifyRemoteByContent && record.remoteModifiedTime) {
    if (metaTime !== undefined && metaTime === record.remoteModifiedTime) return { changed: false, metaTime };
  }
  const hash = await fetchedHash(input, documentId);
  // 取回校验过的文档：把当前时间戳带出去，执行后写回记录，下一轮才能走快路径
  return { changed: hash !== record.baseRemoteHash, hash, metaTime };
}

async function fetchedHash(input: DocPlannerInput, documentId: string): Promise<string> {
  const cached = input.cache.fetchedHash.get(documentId);
  if (cached !== undefined) return cached;
  const hash = await input.hashFetched(await fetchCached(input, documentId));
  input.cache.fetchedHash.set(documentId, hash);
  return hash;
}

/** 取回内容过「下行规则」之后的样子——这正是 pull 会写进本地的内容。 */
export async function pulledContent(
  input: DocPlannerInput,
  relPath: string,
  remoteNote: DocRemoteNote,
  localNote: LocalNote | undefined,
): Promise<string> {
  const cached = input.cache.pulled.get(relPath);
  if (cached !== undefined) return cached;
  const fetched = await fetchCached(input, remoteNote.documentId);
  const localText = localNote ? await readLocalCached(input, relPath) : "";
  const pulled = applyRules(
    "toObsidian",
    fetched,
    { relPath, documentTitle: documentTitleFor(relPath, input.settings), localContent: localText },
    input.rules,
  );
  input.cache.pulled.set(relPath, pulled);
  return pulled;
}

async function isLocalChanged(
  input: DocPlannerInput,
  record: { baseLocalHash: string; localSize: number; localMtime: number },
  localNote: LocalNote,
): Promise<boolean> {
  if (record.localSize === localNote.size && record.localMtime === localNote.mtime && record.baseLocalHash) {
    return false;
  }
  const hash = await hashLocalCached(input, localNote.relPath);
  return hash !== record.baseLocalHash;
}

/**
 * 文档模式的四态判定。两条基线分开记：baseLocalHash 是本地笔记的哈希，baseRemoteHash 是 fetch
 * 回来那份 Markdown 的哈希（飞书会规范化格式，同一份内容发上去取回来不等于本地原文，
 * 拿本地形态当远端基线会永远判定"远端变了"，反复来回拉扯）。
 */
export async function buildDocPlan(input: DocPlannerInput): Promise<SyncPlan> {
  const { state, local, remote } = input;
  const items: PlanItem[] = [];
  const relPaths = new Set<string>([...local.keys(), ...remote.notes.keys(), ...Object.keys(state.docRecords)]);

  for (const relPath of Array.from(relPaths).sort()) {
    if (input.isExcluded(relPath)) continue;

    const localNote = local.get(relPath);
    const remoteNote = remote.notes.get(relPath);
    const record = state.docRecords[relPath];
    const remoteFields: Partial<PlanItem> = remoteNote
      ? { remoteTitle: remoteNote.title, nodeToken: remoteNote.nodeToken, documentId: remoteNote.documentId }
      : {};

    // 强制重推：只看本地有没有内容，忽略两边基线（改了上行规则后用来刷新历史文档）
    if (input.forcePush && localNote && localNote.size > 0) {
      items.push(
        item(relPath, remoteNote ? "push" : "create-remote", "强制重推：忽略基线", {
          ...remoteFields,
          localSize: localNote.size,
          localMtime: localNote.mtime,
        }),
      );
      continue;
    }

    if (!record) {
      if (localNote && remoteNote) {
        const [pulled, localText, localHash, hash] = await Promise.all([
          pulledContent(input, relPath, remoteNote, localNote),
          readLocalCached(input, relPath),
          hashLocalCached(input, relPath),
          fetchedHash(input, remoteNote.documentId),
        ]);
        const extra = { ...remoteFields, localHash, remoteHash: hash, localSize: localNote.size, localMtime: localNote.mtime };
        if (pulled === localText) {
          items.push(item(relPath, "link", "两边内容一致，只建立映射", extra));
        } else {
          items.push(conflictItem(relPath, state, "首次对接：同名文档两边内容不同，已保留双方", extra, localHash, hash));
        }
        continue;
      }
      if (localNote) {
        items.push(
          item(
            relPath,
            "create-remote",
            localNote.size === 0 ? "空笔记在文档模式下也会同步（<title> 保证 content 非空）" : undefined,
          ),
        );
        continue;
      }
      if (remoteNote) {
        items.push(item(relPath, "create-local", undefined, remoteFields));
      }
      continue;
    }

    if (!localNote && !remoteNote) {
      items.push(item(relPath, "forget", "两边都已不存在，清理映射"));
      continue;
    }

    if (!localNote) {
      const remoteState = await remoteChangedState(input, record, remoteNote!.documentId);
      const hash = remoteState.hash ?? record.baseRemoteHash;
      const stamp = remoteState.metaTime ? { remoteModifiedTime: remoteState.metaTime } : {};
      if (remoteState.changed) {
        items.push(
          conflictItem(
            relPath,
            state,
            "本地已删除、远端被修改：为避免丢内容，未自动处理",
            { ...remoteFields, localHash: "", remoteHash: hash },
            "",
            hash,
          ),
        );
      } else if (input.propagateLocalDelete) {
        items.push(
          item(relPath, "delete-remote", "本地已删除，按设置删除远端文档（进飞书回收站，可恢复）", {
            ...remoteFields,
            ...stamp,
          }),
        );
      } else {
        items.push(item(relPath, "local-deleted", "本地已删除、远端未变（未自动删除远端）", { ...remoteFields, ...stamp }));
      }
      continue;
    }

    if (!remoteNote) {
      const localChanged = await isLocalChanged(input, record, localNote);
      if (!localChanged) {
        if (input.propagateRemoteDelete) {
          items.push(
            item(relPath, "delete-local", "远端已删除且本地未变，按设置把本地笔记移进 .trash", {
              localSize: localNote.size,
              localMtime: localNote.mtime,
            }),
          );
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

    const localChanged = await isLocalChanged(input, record, localNote);
    const remoteState = await remoteChangedState(input, record, remoteNote.documentId);
    const remoteChanged = remoteState.changed;
    const hash = remoteState.hash;
    const localHash = await hashLocalCached(input, relPath);
    const extra = {
      ...remoteFields,
      localHash,
      remoteHash: hash,
      localSize: localNote.size,
      localMtime: localNote.mtime,
      remoteModifiedTime: remoteState.metaTime,
    };

    if (!localChanged && !remoteChanged) {
      items.push(item(relPath, "skip", undefined, extra));
      continue;
    }
    if (localChanged && !remoteChanged) {
      items.push(item(relPath, "push", undefined, extra));
      continue;
    }
    if (!localChanged && remoteChanged) {
      items.push(item(relPath, "pull", undefined, extra));
      continue;
    }
    const [pulled, localText] = await Promise.all([
      pulledContent(input, relPath, remoteNote, localNote),
      readLocalCached(input, relPath),
    ]);
    if (pulled === localText) {
      items.push(item(relPath, "link", "两边内容一致，只更新基线", extra));
      continue;
    }
    items.push(conflictItem(relPath, state, "两边都改过且内容不同，已保留双方", extra, localHash, hash ?? localHash));
  }

  return {
    items,
    counts: summarize(items),
    localNoteCount: local.size,
    remoteNoteCount: remote.notes.size,
  };
}
