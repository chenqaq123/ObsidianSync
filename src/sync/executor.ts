import { assertRemoteAbsent } from "./guards";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { FeishuClient } from "../feishu/client";
import { batchQueryMetas, deleteDriveFile, downloadFile, uploadMarkdownToWiki } from "../feishu/files";
import { createContainerNode, getNodeByToken, listNodes } from "../feishu/wiki";
import type { Logger } from "../log";
import { describeError, ensureFolder } from "../log";
import { sha256Hex } from "./hash";
import { localStat, readLocalBytes, writeLocalBytes } from "./scanner";
import type { FileRecord, PlanItem, PluginSettings, SyncAction, SyncPlan, SyncState } from "./types";
import { CONFLICT_DIR, basenameOf, dirnameOf } from "./types";

export interface ReportEntry {
  relPath: string;
  action: SyncAction;
  ok: boolean;
  message?: string;
  copyPath?: string;
}

export interface ExecutionContext {
  app: App;
  client: FeishuClient;
  settings: PluginSettings;
  state: SyncState;
  logger: Logger;
  spaceId: string;
  /** 留空表示以知识空间顶层为同步根 */
  rootNodeToken?: string;
}

export interface ExecutionOptions {
  allowPush: boolean;
  allowPull: boolean;
  isEditorDirty: (relPath: string) => Promise<boolean>;
  onProgress?: (message: string, done: number, total: number) => void;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function conflictCopyRelPath(relPath: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  const base = relPath.replace(/\.md$/i, "");
  return `${CONFLICT_DIR}/${base}.${stamp}.md`;
}

function existsLocally(app: App, relPath: string): boolean {
  return app.vault.getAbstractFileByPath(relPath) instanceof TFile;
}

async function hashLocalFile(app: App, relPath: string): Promise<string> {
  return sha256Hex(await readLocalBytes(app, relPath));
}

export async function executePlan(plan: SyncPlan, ctx: ExecutionContext, options: ExecutionOptions): Promise<ReportEntry[]> {
  const reports: ReportEntry[] = [];
  const { state, settings } = ctx;

  const folderNodes = new Map<string, string>();
  let rootContainerToken: string | undefined;

  /**
   * 文件必须挂在某个页面节点下（upload_all 用 parent_node 识别知识空间，空间顶层放不了文件）。
   * 未指定同步根节点时，在空间顶层按需建一个页面专门存放 vault 根目录下的笔记。
   */
  const ensureRootContainer = async (): Promise<string> => {
    if (ctx.rootNodeToken) return ctx.rootNodeToken;
    if (rootContainerToken) return rootContainerToken;
    const cached = state.folders[""];
    if (cached?.nodeToken) {
      rootContainerToken = cached.nodeToken;
      return rootContainerToken;
    }
    const title = settings.rootPageTitle.trim() || ctx.app.vault.getName();
    const topLevel = await listNodes(ctx.client, ctx.spaceId);
    const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
    if (found?.node_token) {
      state.folders[""] = { nodeToken: found.node_token };
      rootContainerToken = found.node_token;
      ctx.logger.info(`复用知识库顶层页面「${title}」存放 vault 根目录下的笔记`);
      return rootContainerToken;
    }
    const node = await createContainerNode(ctx.client, ctx.spaceId, undefined, title);
    state.folders[""] = { nodeToken: node.node_token };
    rootContainerToken = node.node_token;
    ctx.logger.info(`在知识库顶层创建页面「${title}」存放 vault 根目录下的笔记`);
    return rootContainerToken;
  };

  const resolveFolderNode = async (relDir: string, needFileParent: boolean): Promise<string | undefined> => {
    // needFileParent=false 只用于建目录节点：未指定根节点时目录直接挂空间顶层
    if (settings.folderMode === "flat" || relDir === "") {
      return needFileParent ? ensureRootContainer() : ctx.rootNodeToken;
    }
    const cached = folderNodes.get(relDir);
    if (cached) return cached;
    const existing = state.folders[relDir];
    if (existing?.nodeToken) {
      folderNodes.set(relDir, existing.nodeToken);
      return existing.nodeToken;
    }
    const parentDir = dirnameOf(relDir);
    const parentNode = await resolveFolderNode(parentDir, false);
    const node = await createContainerNode(ctx.client, ctx.spaceId, parentNode, basenameOf(relDir));
    state.folders[relDir] = { nodeToken: node.node_token, parentNodeToken: parentNode };
    folderNodes.set(relDir, node.node_token);
    ctx.logger.info(`创建知识库目录节点 ${relDir} -> ${node.node_token}`);
    return node.node_token;
  };

  const remoteFileName = (relPath: string): string =>
    settings.folderMode === "flat" ? relPath.split("/").join(settings.flatSeparator) : basenameOf(relPath);

  const writeConflictCopy = async (relPath: string, bytes: ArrayBuffer, localHash: string, remoteHash: string): Promise<string> => {
    const copyPath = conflictCopyRelPath(relPath);
    const adapter = ctx.app.vault.adapter;
    await ensureFolder(adapter, dirnameOf(copyPath));
    await adapter.writeBinary(copyPath, bytes);
    state.conflicts[relPath] = { remoteHash, localHash, copyPath, at: Date.now() };
    return copyPath;
  };

  const pushes = plan.items.filter((entry) => entry.action === "push" || entry.action === "create-remote");
  const pulls = plan.items.filter((entry) => entry.action === "pull" || entry.action === "create-local");
  const links = plan.items.filter((entry) => entry.action === "link");
  const conflicts = plan.items.filter((entry) => entry.action === "conflict");
  const remoteDeletes = plan.items.filter((entry) => entry.action === "delete-remote");
  const localDeletes = plan.items.filter((entry) => entry.action === "delete-local");
  const observed = plan.items.filter((entry) =>
    ["local-deleted", "remote-deleted", "empty-local", "dirty-editor", "forget"].includes(entry.action),
  );

  const steps: (() => Promise<void>)[] = [];
  let stepIndex = 0;
  const totalSteps =
    (options.allowPush ? pushes.length + remoteDeletes.length : 0) +
    (options.allowPull ? pulls.length + localDeletes.length : 0) +
    links.length +
    conflicts.length;
  const tick = (message: string) => {
    stepIndex += 1;
    options.onProgress?.(message, stepIndex, totalSteps);
  };

  if (options.allowPush) {
    for (const entry of pushes) {
      steps.push(async () => {
        try {
          const statBefore = localStat(ctx.app, entry.relPath);
          const bytes = await readLocalBytes(ctx.app, entry.relPath);
          if (await options.isEditorDirty(entry.relPath) ||
              (entry.localHash !== undefined && await sha256Hex(bytes) !== entry.localHash)) {
            throw new Error("预览后本地正文已改变，请保存后重新预览");
          }
          if (entry.action === "push") {
            const previous = state.records[entry.relPath];
            const token = entry.fileToken ?? previous?.fileToken;
            if (!token || await sha256Hex(await downloadFile(ctx.client, token)) !== (entry.remoteHash ?? previous?.baseHash)) {
              throw new Error("预览后飞书正文已改变，已停止覆盖，请重新同步");
            }
          }
          const parentNode = await resolveFolderNode(entry.parentDir, true);
          const record = state.records[entry.relPath];
          const previousToken = entry.action === "push" ? record?.fileToken : undefined;
          const result = await uploadMarkdownToWiki(
            ctx.client,
            {
              spaceId: ctx.spaceId,
              parentNode,
              fileName: remoteFileName(entry.relPath),
              data: bytes,
              fileToken: previousToken,
            },
            (reason) => ctx.logger.warn(`直接上传到知识库节点失败，改用云空间中转：${reason}`),
          );
          const hash = await sha256Hex(bytes);
          const statAfter = localStat(ctx.app, entry.relPath);
          // 上传期间文件若被改动，基线的 size/mtime 不能指向新内容，用 -1 逼下次重新按内容校验
          const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
          let nodeToken = record?.nodeToken;
          if (result.fileToken !== record?.fileToken) {
            const node = await getNodeByToken(ctx.client, result.fileToken, "file").catch(() => undefined);
            nodeToken = node?.node_token;
          }
          state.records[entry.relPath] = {
            fileToken: result.fileToken,
            nodeToken,
            parentNodeToken: parentNode,
            baseHash: hash,
            localSize: stable ? statAfter.size : -1,
            localMtime: stable ? statAfter.mtime : -1,
            remoteModifiedTime: undefined,
            remoteVersion: result.version,
            lastSyncedAt: Date.now(),
          };
          delete state.conflicts[entry.relPath];
          reports.push({ relPath: entry.relPath, action: entry.action, ok: true });
          tick(`上传 ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`上传 ${entry.relPath} 失败：${describeError(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError(error) });
          tick(`上传失败 ${entry.relPath}`);
        }
      });
    }
  }

  if (options.allowPull) {
    for (const entry of pulls) {
      steps.push(async () => {
        const record = state.records[entry.relPath];
        const fileToken = entry.fileToken ?? record?.fileToken;
        if (!fileToken) {
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: "缺少远端 file_token" });
          tick(`跳过 ${entry.relPath}`);
          return;
        }
        try {
          const present = existsLocally(ctx.app, entry.relPath);
          if (entry.action === "pull" && !present) {
            reports.push({
              relPath: entry.relPath,
              action: entry.action,
              ok: true,
              message: "生成计划后本地文件已被删除，未重新创建（如需恢复请再跑一次同步）",
            });
            tick(`跳过 ${entry.relPath}`);
            return;
          }

          // 计划生成到写盘之间用户可能已经保存了新改动，写盘前必须复核
          if (present && (entry.localSize !== undefined || entry.localMtime !== undefined)) {
            const before = localStat(ctx.app, entry.relPath);
            const movedSincePlan = before.size !== entry.localSize || before.mtime !== entry.localMtime;
            if (movedSincePlan) {
              const remoteBytes = await downloadFile(ctx.client, fileToken);
              const remoteHash = await sha256Hex(remoteBytes);
              const currentLocalHash = await hashLocalFile(ctx.app, entry.relPath);
              if (currentLocalHash !== remoteHash) {
                const copyPath = await writeConflictCopy(entry.relPath, remoteBytes, currentLocalHash, remoteHash);
                reports.push({
                  relPath: entry.relPath,
                  action: "conflict",
                  ok: true,
                  message: "计划生成后本地又有新改动，已改为保留双方，本地与远端都未改动",
                  copyPath,
                });
                ctx.logger.warn(`拉取前发现本地已改动，转为冲突：${entry.relPath}`);
                tick(`冲突 ${entry.relPath}`);
                return;
              }
              state.records[entry.relPath] = {
                fileToken,
                nodeToken: entry.nodeToken ?? record?.nodeToken,
                parentNodeToken: record?.parentNodeToken,
                baseHash: currentLocalHash,
                localSize: before.size,
                localMtime: before.mtime,
                remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
                remoteVersion: record?.remoteVersion,
                lastSyncedAt: Date.now(),
              };
              delete state.conflicts[entry.relPath];
              reports.push({ relPath: entry.relPath, action: "link", ok: true, message: "两边内容一致，只更新了基线" });
              tick(`建立映射 ${entry.relPath}`);
              return;
            }
          }

          if (present && (await options.isEditorDirty(entry.relPath))) {
            reports.push({ relPath: entry.relPath, action: "dirty-editor", ok: true, message: "文件正在编辑且未保存，未覆盖" });
            tick(`跳过编辑中的 ${entry.relPath}`);
            return;
          }

          const bytes = await downloadFile(ctx.client, fileToken);
          if (entry.action === "create-local" && present) {
            const currentLocalHash = await hashLocalFile(ctx.app, entry.relPath);
            const remoteHash = await sha256Hex(bytes);
            if (currentLocalHash !== remoteHash) {
              const copyPath = await writeConflictCopy(entry.relPath, bytes, currentLocalHash, remoteHash);
              reports.push({
                relPath: entry.relPath,
                action: "conflict",
                ok: true,
                message: "本地在计划生成后出现了同名文件且内容不同，已保留双方",
                copyPath,
              });
              tick(`冲突 ${entry.relPath}`);
              return;
            }
          }

          const presentNow = existsLocally(ctx.app, entry.relPath);
          if (presentNow !== present || (presentNow && (await options.isEditorDirty(entry.relPath) ||
              (entry.localHash !== undefined && await hashLocalFile(ctx.app, entry.relPath) !== entry.localHash)))) {
            throw new Error("下载期间本地笔记已改变，未覆盖，请重新同步");
          }
          await writeLocalBytes(ctx.app, entry.relPath, bytes);
          const hash = await sha256Hex(bytes);
          const stat = localStat(ctx.app, entry.relPath);
          state.records[entry.relPath] = {
            fileToken,
            nodeToken: entry.nodeToken ?? record?.nodeToken,
            parentNodeToken: record?.parentNodeToken,
            baseHash: hash,
            localSize: stat.size,
            localMtime: stat.mtime,
            remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
            remoteVersion: record?.remoteVersion,
            lastSyncedAt: Date.now(),
          };
          delete state.conflicts[entry.relPath];
          reports.push({ relPath: entry.relPath, action: entry.action, ok: true });
          tick(`下载 ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`下载 ${entry.relPath} 失败：${describeError(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError(error) });
          tick(`下载失败 ${entry.relPath}`);
        }
      });
    }
  }

  for (const entry of links) {
    steps.push(async () => {
      try {
        const statBefore = localStat(ctx.app, entry.relPath);
        const bytes = await readLocalBytes(ctx.app, entry.relPath);
        const hash = await sha256Hex(bytes);
        const statAfter = localStat(ctx.app, entry.relPath);
        const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
        const existing = state.records[entry.relPath];
        const fileToken = entry.fileToken ?? existing?.fileToken;
        if (!fileToken || await options.isEditorDirty(entry.relPath) || hash !== entry.localHash ||
            await sha256Hex(await downloadFile(ctx.client, fileToken)) !== entry.remoteHash) {
          throw new Error("预览后内容已改变，未更新映射，请重新同步");
        }
        state.records[entry.relPath] = {
          fileToken: entry.fileToken ?? existing?.fileToken ?? "",
          nodeToken: entry.nodeToken ?? existing?.nodeToken,
          parentNodeToken: existing?.parentNodeToken,
          baseHash: hash,
          localSize: stable ? statAfter.size : -1,
          localMtime: stable ? statAfter.mtime : -1,
          remoteModifiedTime: entry.remoteModifiedTime,
          remoteVersion: entry.remoteVersion ?? existing?.remoteVersion,
          lastSyncedAt: Date.now(),
        };
        delete state.conflicts[entry.relPath];
        reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
        tick(`建立映射 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError(error) });
        tick(`建立映射失败 ${entry.relPath}`);
      }
    });
  }

  for (const entry of conflicts) {
    steps.push(async () => {
      const record = state.records[entry.relPath];
      const fileToken = entry.fileToken ?? record?.fileToken;
      const previous = state.conflicts[entry.relPath];
      if (entry.duplicateConflict && previous) {
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "仍是上次未处理的冲突，未重复生成副本",
          copyPath: previous.copyPath,
        });
        tick(`冲突 ${entry.relPath}`);
        return;
      }
      if (!fileToken) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: "缺少远端 file_token，无法取出冲突版本" });
        tick(`冲突 ${entry.relPath}`);
        return;
      }
      try {
        const bytes = await downloadFile(ctx.client, fileToken);
        const remoteHash = await sha256Hex(bytes);
        const present = existsLocally(ctx.app, entry.relPath);
        const localHash = present ? await hashLocalFile(ctx.app, entry.relPath) : "";
        if (previous && previous.remoteHash === remoteHash && previous.localHash === localHash) {
          reports.push({
            relPath: entry.relPath,
            action: "conflict",
            ok: true,
            message: "仍是上次未处理的冲突，未重复生成副本",
            copyPath: previous.copyPath,
          });
          tick(`冲突 ${entry.relPath}`);
          return;
        }
        const copyPath = await writeConflictCopy(entry.relPath, bytes, localHash, remoteHash);
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "远端版本已另存为副本，本地与远端都未改动",
          copyPath,
        });
        ctx.logger.warn(`冲突：${entry.relPath} -> ${copyPath}`);
        tick(`冲突 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: describeError(error) });
        tick(`冲突处理失败 ${entry.relPath}`);
      }
    });
  }

  for (const step of steps) {
    await step();
  }

  // 删除放在上传/拉取之后：先删后建会在远端留下同名冲突
  if (options.allowPush) {
    for (const entry of remoteDeletes) {
      const record = state.records[entry.relPath];
      const fileToken = entry.fileToken ?? record?.fileToken;
      const title = entry.remoteTitle ?? entry.relPath;
      if (!fileToken) {
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: "缺少远端 file_token，未删除" });
        tick(`跳过删除 ${entry.relPath}`);
        continue;
      }
      try {
        if (existsLocally(ctx.app, entry.relPath) || await options.isEditorDirty(entry.relPath)) {
          throw new Error("本地笔记已恢复或正在编辑，未删除远端，请重新预览");
        }
        const remoteHashNow = await sha256Hex(await downloadFile(ctx.client, fileToken));
        if (!record || remoteHashNow !== record.baseHash) {
          throw new Error("飞书内容在预览后已改变，未删除，请重新同步");
        }
        if (existsLocally(ctx.app, entry.relPath) || await options.isEditorDirty(entry.relPath)) {
          throw new Error("检查期间本地笔记已恢复，未删除远端");
        }
        await deleteDriveFile(ctx.client, fileToken, "file");
        delete state.records[entry.relPath];
        delete state.conflicts[entry.relPath];
        ctx.logger.info(`已删除远端文件 ${title}（${fileToken}），进飞书回收站可恢复`);
        reports.push({
          relPath: entry.relPath,
          action: "delete-remote",
          ok: true,
          message: `已删除远端「${title}」（进飞书回收站，可恢复）`,
        });
        tick(`删除远端 ${entry.relPath}`);
      } catch (error) {
        // 删除失败保留映射，下次还能重试
        ctx.logger.error(`删除远端 ${entry.relPath} 失败：${describeError(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: describeError(error) });
        tick(`删除远端失败 ${entry.relPath}`);
      }
    }
  }

  if (options.allowPull) {
    for (const entry of localDeletes) {
      try {
        const file = existsLocally(ctx.app, entry.relPath) ? ctx.app.vault.getAbstractFileByPath(entry.relPath) : null;
        if (file) {
          await assertRemoteAbsent(ctx.client, ctx.spaceId, ctx.rootNodeToken, state.records[entry.relPath]?.fileToken);
          if (await options.isEditorDirty(entry.relPath) || !entry.localHash || await hashLocalFile(ctx.app, entry.relPath) !== entry.localHash) {
            throw new Error("本地笔记在预览后已改变，未删除，请重新同步");
          }
          await ctx.app.vault.trash(file, false);
        }
        delete state.records[entry.relPath];
        delete state.conflicts[entry.relPath];
        reports.push({
          relPath: entry.relPath,
          action: "delete-local",
          ok: true,
          message: file ? "远端已删除，本地笔记已移入 .trash" : "远端已删除，本地文件已不存在，只清理了映射",
        });
        tick(`删除本地 ${entry.relPath}`);
      } catch (error) {
        ctx.logger.error(`删除本地 ${entry.relPath} 失败：${describeError(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-local", ok: false, message: describeError(error) });
        tick(`删除本地失败 ${entry.relPath}`);
      }
    }
  }

  if (options.allowPush && pushes.length > 0) {
    await refreshRemoteModifiedTime(ctx, pushes);
  }

  for (const entry of observed) {
    if (entry.action === "forget") {
      delete state.records[entry.relPath];
      delete state.conflicts[entry.relPath];
    }
    reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
  }

  state.lastSyncAt = Date.now();
  return reports;
}

async function refreshRemoteModifiedTime(ctx: ExecutionContext, entries: PlanItem[]): Promise<void> {
  const tokens: string[] = [];
  for (const entry of entries) {
    const record: FileRecord | undefined = ctx.state.records[entry.relPath];
    if (record?.fileToken) tokens.push(record.fileToken);
  }
  if (tokens.length === 0) return;
  try {
    const metas = await batchQueryMetas(ctx.client, tokens);
    for (const entry of entries) {
      const record = ctx.state.records[entry.relPath];
      if (!record) continue;
      const meta = metas.get(record.fileToken);
      if (meta?.modifiedTime) record.remoteModifiedTime = meta.modifiedTime;
    }
  } catch (error) {
    ctx.logger.warn(`刷新远端元数据失败（下次同步会重新校验内容）：${describeError(error)}`);
  }
}
