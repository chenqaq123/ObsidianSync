import type { App } from "obsidian";
import type { FeishuClient } from "../feishu/client";
import { batchQueryMetas, deleteDriveFile, downloadFile, uploadMarkdownToWiki } from "../feishu/files";
import { getNodeByToken } from "../feishu/wiki";
import type { Logger } from "../log";
import { describeError } from "../log";
import { assertRemoteAbsent } from "./guards";
import type { FolderResolver } from "./folders";
import { createFolderResolver } from "./folders";
import { existsLocally } from "./plan-shared";
import { mapConcurrent } from "./concurrency";
import { sha256Hex } from "./hash";
import { localStat, readLocalBytes, writeLocalBytes } from "./scanner";
import type { FileRecord, PlanItem, PluginSettings, SyncAction, SyncPlan, SyncState } from "./types";
import { basenameOf } from "./types";

export interface ReportEntry {
  relPath: string;
  action: SyncAction;
  ok: boolean;
  message?: string;
  copyPath?: string;
}

interface ExecutionContext {
  app: App;
  client: FeishuClient;
  settings: PluginSettings;
  state: SyncState;
  logger: Logger;
  spaceId: string;
  /** 留空表示以知识空间顶层为同步根 */
  rootNodeToken?: string;
}

interface ExecutionOptions {
  allowPush: boolean;
  allowPull: boolean;
  isEditorDirty: (relPath: string) => Promise<boolean>;
  onProgress?: (message: string, done: number, total: number) => void;
}

async function hashLocalFile(app: App, relPath: string): Promise<string> {
  return sha256Hex(await readLocalBytes(app, relPath));
}

export async function executePlan(plan: SyncPlan, ctx: ExecutionContext, options: ExecutionOptions): Promise<ReportEntry[]> {
  const reports: ReportEntry[] = [];
  const { state, settings } = ctx;

  const folders: FolderResolver = createFolderResolver({
    app: ctx.app,
    client: ctx.client,
    state,
    settings,
    spaceId: ctx.spaceId,
    rootNodeToken: ctx.rootNodeToken,
    logger: ctx.logger,
  });

  // 文件镜像走云空间文件接口，必须挂在某个页面节点下（空间顶层放不了文件）
  const resolveFolderNode = (relDir: string) => folders.resolveFolderNode(relDir, true);

  const remoteFileName = (relPath: string): string =>
    settings.folderMode === "flat" ? relPath.split("/").join(settings.flatSeparator) : basenameOf(relPath);

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
          // 预览后本地正文或远端内容变了都不能覆盖
          if (await options.isEditorDirty(entry.relPath) ||
              (entry.localHash !== undefined && await sha256Hex(bytes) !== entry.localHash)) {
            throw new Error("预览后本地正文已改变，请保存后重新预览");
          }
          if (entry.action === "push" && !entry.forceOverwrite) {
            const previous = state.records[entry.relPath];
            const token = entry.fileToken ?? previous?.fileToken;
            if (!token || await sha256Hex(await downloadFile(ctx.client, token)) !== (entry.remoteHash ?? previous?.baseHash)) {
              throw new Error("预览后飞书正文已改变，已停止覆盖，请重新同步");
            }
          }
          const parentNode = await resolveFolderNode(entry.parentDir);
          const record = state.records[entry.relPath];
          // 冲突转推送时可能没有旧记录，用计划里的 fileToken 原位覆盖
          const previousToken = entry.action === "push" ? (entry.fileToken ?? record?.fileToken) : undefined;
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
          // 上传期间文件若被改动，基线 size/mtime 置 -1 逼下次按内容校验
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

          // 计划生成到写盘之间用户可能已保存新改动，写盘前必须复核
          if (present && (entry.localSize !== undefined || entry.localMtime !== undefined)) {
            const before = localStat(ctx.app, entry.relPath);
            const movedSincePlan = before.size !== entry.localSize || before.mtime !== entry.localMtime;
            if (movedSincePlan) {
              const remoteBytes = await downloadFile(ctx.client, fileToken);
              const remoteHash = await sha256Hex(remoteBytes);
              const currentLocalHash = await hashLocalFile(ctx.app, entry.relPath);
              if (currentLocalHash !== remoteHash) {
                reports.push({
                  relPath: entry.relPath,
                  action: "conflict",
                  ok: true,
                  message: "计划生成后本地又有新改动，已转为等待手动合并，本地与远端都未改动",
                });
                ctx.logger.warn(`拉取前发现本地已改动，转为手动合并：${entry.relPath}`);
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
              reports.push({
                relPath: entry.relPath,
                action: "conflict",
                ok: true,
                message: "本地在计划生成后出现了同名文件且内容不同，等待手动合并，两边均未改动",
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
      // 保留基线，冲突会在下轮继续出现；只有明确的推送或拉取才算解决。
      reports.push({
        relPath: entry.relPath,
        action: "conflict",
        ok: true,
        message: "等待手动合并，本地与远端均未改动",
      });
      ctx.logger.warn(`等待手动合并：${entry.relPath}`);
      tick(`等待手动合并 ${entry.relPath}`);
    });
  }

  await mapConcurrent(steps, 4, (step) => step());

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
