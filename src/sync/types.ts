import type { UserTokens, AuthMode } from "../feishu/auth";
import type { WikiTreeEntry } from "../feishu/wiki";

export type SyncAction =
  | "skip"
  | "push"
  | "create-remote"
  | "pull"
  | "create-local"
  | "link"
  | "conflict"
  | "delete-remote"
  | "delete-local"
  | "local-deleted"
  | "remote-deleted"
  | "empty-local"
  | "dirty-editor"
  | "forget";

export interface PlanItem {
  relPath: string;
  action: SyncAction;
  reason?: string;
  parentDir: string;
  remoteTitle?: string;
  fileToken?: string;
  nodeToken?: string;
  remoteModifiedTime?: string;
  remoteVersion?: string;
  localHash?: string;
  remoteHash?: string;
  localSize?: number;
  localMtime?: number;
  duplicateConflict?: boolean;
  /** 文档模式：远端 docx 文档 id */
  documentId?: string;
  /** Rule-only refresh: recheck the remote content before overwriting a previewed plan. */
  rulesRefresh?: boolean;
}

export interface SyncPlan {
  settingsFingerprint?: string;
  items: PlanItem[];
  counts: Record<string, number>;
  localNoteCount: number;
  remoteNoteCount: number;
  publishRulesFingerprint?: string;
  pullRulesFingerprint?: string;
  warnings?: { relPath: string; message: string }[];
}

export const ACTION_LABELS: Record<SyncAction, string> = {
  skip: "已同步",
  push: "上传覆盖",
  "create-remote": "上传新建",
  pull: "拉取覆盖",
  "create-local": "拉取新建",
  link: "建立映射",
  conflict: "冲突",
  "delete-remote": "删除远端",
  "delete-local": "删除本地",
  "local-deleted": "本地已删除",
  "remote-deleted": "远端已删除",
  "empty-local": "跳过空文件",
  "dirty-editor": "跳过（编辑中）",
  forget: "清理映射",
};

export interface FileRecord {
  fileToken: string;
  nodeToken?: string;
  parentNodeToken?: string;
  baseHash: string;
  localSize: number;
  localMtime: number;
  remoteModifiedTime?: string;
  remoteVersion?: string;
  lastSyncedAt: number;
}

export interface ConflictRecord {
  remoteHash: string;
  localHash: string;
  copyPath: string;
  at: number;
}

/** 远端图片 token → 本地附件文件（避免每次拉取都新增副本） */
export interface ImageDownloadRecord {
  path: string;
  token: string;
  /** 附件内容的哈希，用来按内容复用已存在的本地文件 */
  hash?: string;
  at: number;
}

/** 已上传图片的复用缓存：同一文档 + 同一内容哈希，不重复上传 */
export interface ImageUploadRecord {
  fileToken: string;
  documentId: string;
  hash: string;
  /** 上传来源的本地文件，下行遇到同样内容时可以直接复用 */
  path?: string;
  at: number;
}

/** 文档模式：一篇笔记对应一篇飞书新版文档（docx）。 */
export interface DocRecord {
  documentId: string;
  nodeToken?: string;
  parentNodeToken?: string;
  /** 实际用的文档标题（笔记名与目录同名时会带 (note) 后缀） */
  documentTitle?: string;
  baseLocalHash: string;
  /** 取回形态（fetch 回来的 Markdown）的哈希，飞书会做格式规范化，不能用本地形态当远端基线 */
  baseRemoteHash: string;
  publishRulesFingerprint?: string;
  /** 飞书返回的最后修改时间（Unix 秒字符串），用来跳过每轮的全文取回 */
  remoteModifiedTime?: string;
  localSize: number;
  localMtime: number;
  lastSyncedAt: number;
  conflict?: boolean;
}

export interface FolderRecord {
  nodeToken: string;
  parentNodeToken?: string;
}

export interface SyncTarget {
  spaceId: string;
  rootNodeToken: string;
  /** 上次同步用的模式，用于发现模式切换后重按「首次对接」判定 */
  syncMode?: SyncModeSetting;
  folderMode?: "nodes" | "flat";
  flatSeparator?: string;
  rootPageTitle?: string;
}

export interface SyncState {
  records: Record<string, FileRecord>;
  folders: Record<string, FolderRecord>;
  conflicts: Record<string, ConflictRecord>;
  docRecords: Record<string, DocRecord>;
  /** 远端图片 token → 本地附件（文档模式下行） */
  images: Record<string, ImageDownloadRecord>;
  /** 图片内容哈希 + 文档 id → 已上传素材（文档模式上行复用） */
  imageUploads: Record<string, ImageUploadRecord>;
  target?: SyncTarget;
  lastSyncAt?: number;
}

export function emptyState(): SyncState {
  return { records: {}, folders: {}, conflicts: {}, docRecords: {}, images: {}, imageUploads: {} };
}

/** 笔记同步形态：md 为原生 Markdown 文件镜像，doc 为飞书新版文档 */
export type SyncModeSetting = "md" | "doc";

export interface PluginSettings {
  authMode: AuthMode;
  appId: string;
  appSecret: string;
  oauthScope: string;
  redirectUri: string;
  spaceId: string;
  rootNodeToken: string;
  rootPageTitle: string;
  /** md：把笔记当原生 Markdown 文件镜像；doc：把笔记同步成飞书新版文档 */
  syncMode: SyncModeSetting;
  folderMode: "nodes" | "flat";
  flatSeparator: string;
  excludePatterns: string;
  recreateRemoteIfDeleted: boolean;
  /** 本地已删除的笔记，同步时把远端一起删掉（飞书进回收站，可恢复） */
  propagateLocalDelete: boolean;
  /** 远端已删除的文件/文档，同步时把本地笔记移进 .trash */
  propagateRemoteDelete: boolean;
  /** 远程图片下载到本地的附件目录（相对 vault 根） */
  attachmentFolder: string;
  /** 文档模式安全阀：忽略远端修改时间戳，每轮都取回全文校验 */
  docVerifyRemoteByContent: boolean;
  attachmentLinkStyle: "shortest" | "path";
  showPlanBeforeSync: boolean;
  autoSyncMinutes: number;
  debugLog: boolean;
  userTokens?: UserTokens;
  state: SyncState;
}

export const CONFLICT_DIR = ".obsidian/feishu-sync/conflicts";

export const DEFAULT_SETTINGS: PluginSettings = {
  authMode: "user",
  appId: "",
  appSecret: "",
  oauthScope: "drive:drive wiki:wiki docs:document.media:download docs:document.media:upload docx:document offline_access",
  redirectUri: "http://localhost:7634/callback",
  spaceId: "",
  rootNodeToken: "",
  rootPageTitle: "",
  syncMode: "md",
  folderMode: "nodes",
  flatSeparator: "__",
  excludePatterns: ".trash/**",
  recreateRemoteIfDeleted: false,
  propagateLocalDelete: false,
  propagateRemoteDelete: false,
  attachmentFolder: "attachments",
  docVerifyRemoteByContent: false,
  attachmentLinkStyle: "shortest",
  showPlanBeforeSync: true,
  autoSyncMinutes: 0,
  debugLog: false,
  state: emptyState(),
};

export interface RemoteNote {
  relPath: string;
  entry: WikiTreeEntry;
  modifiedTime?: string;
}

export interface LocalNote {
  relPath: string;
  size: number;
  mtime: number;
}

export function summarize(items: PlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.action] = (counts[item.action] ?? 0) + 1;
  }
  return counts;
}

export function dirnameOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

export function basenameOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? relPath : relPath.slice(index + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
