import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { LocalImageUpload, RemoteImageRef, ResolvedImage, RuleContext, RulesFile } from "../convert/rules";
import { applyRules, collectRemoteImages, normalizeObsidianMath, publishRulesFingerprint, ruleEnabled, sameAfterCosmeticRules } from "../convert/rules";
import { buildMarkdownContent, createDocumentFromMarkdown, fetchDocumentMarkdown, updateDocumentFromMarkdown } from "../feishu/docs";
import type { DocImageBlock, DocNewBlock } from "../feishu/docImages";
import {
  bindDocImages,
  correlateImageBlocks,
  deleteDocBlocks,
  downloadDocMedia,
  getDocBlockToken,
  listDocImageBlocks,
  uploadDocImage,
} from "../feishu/docImages";
import { deleteDriveFile } from "../feishu/files";
import { getNodeByToken, moveDocToWiki } from "../feishu/wiki";
import type { FeishuClient } from "../feishu/client";
import type { Logger } from "../log";
import { describeError } from "../log";
import { assertRemoteAbsent } from "./guards";
import type { DocPlanCache } from "./docPlanner";
import { documentTitleFor, uniqueDocumentTitle } from "./docPlanner";
import type { FolderResolver } from "./folders";
import { createFolderResolver } from "./folders";
import { existsLocally } from "./plan-shared";
import { mapConcurrent } from "./concurrency";
import type { ReportEntry } from "./executor";
import { localStat, writeLocalBytes } from "./scanner";
import type { PluginSettings, SyncPlan, SyncState } from "./types";

export interface DocExecutionContext {
  app: App;
  client: FeishuClient;
  settings: PluginSettings;
  state: SyncState;
  logger: Logger;
  spaceId: string;
  /** 留空表示以知识空间顶层为同步根 */
  rootNodeToken?: string;
  rules: RulesFile;
  cache: DocPlanCache;
  /** 已经被容器占用的标题：笔记标题撞名时加后缀 */
  containerTitles: Set<string>;
  hashText: (text: string) => Promise<string>;
  /** 远端形态（图片 URL 归一化后）的哈希，必须与计划期同一口径 */
  hashFetched: (text: string) => Promise<string>;
  hashBytes: (bytes: ArrayBuffer) => Promise<string>;
  /** 上行：把 vault 内图片引用解析成真实文件 */
  resolveImage?: (linkpath: string, sourcePath: string) => ResolvedImage | undefined;
  readBinary: (vaultPath: string) => Promise<ArrayBuffer>;
}

interface DocExecutionOptions {
  allowPush: boolean;
  allowPull: boolean;
  isEditorDirty: (relPath: string) => Promise<boolean>;
  onProgress?: (message: string, done: number, total: number) => void;
}

function encodeText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export async function readLocalText(app: App, relPath: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof TFile)) throw new Error(`找不到本地文件：${relPath}`);
  return app.vault.read(file);
}

export async function executeDocPlan(
  plan: SyncPlan,
  ctx: DocExecutionContext,
  options: DocExecutionOptions,
): Promise<ReportEntry[]> {
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

  // 文档要挂到目录节点下；未指定根节点时先建/认根容器
  const resolveFolderNode = (relDir: string) => folders.resolveFolderNode(relDir, true);

  const fetchFresh = async (documentId: string): Promise<string> => {
    const fetched = await fetchDocumentMarkdown(ctx.client, documentId);
    ctx.cache.fetched.set(documentId, fetched);
    ctx.cache.fetchedHash.set(documentId, await ctx.hashFetched(fetched));
    return fetched;
  };

  const fetchedFor = async (documentId: string): Promise<string> => {
    const cached = ctx.cache.fetched.get(documentId);
    if (cached !== undefined) return cached;
    return fetchFresh(documentId);
  };

  const pulls = plan.items.filter((entry) => entry.action === "pull" || entry.action === "create-local");
  const pushes = plan.items.filter((entry) => entry.action === "push" || entry.action === "create-remote");
  const links = plan.items.filter((entry) => entry.action === "link");
  const conflicts = plan.items.filter((entry) => entry.action === "conflict");
  const remoteDeletes = plan.items.filter((entry) => entry.action === "delete-remote");
  const localDeletes = plan.items.filter((entry) => entry.action === "delete-local");
  const observed = plan.items.filter((entry) =>
    ["local-deleted", "remote-deleted", "dirty-editor", "forget"].includes(entry.action),
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
  /** 只刷新提示、不推进步数：给"等待飞书处理文档（第 N 次轮询）"这类过程信息用。 */
  const reportProgress = (message: string) => options.onProgress?.(message, stepIndex, totalSteps);

  if (options.allowPush) {
    for (const entry of pushes) {
      steps.push(async () => {
        try {
          const statBefore = localStat(ctx.app, entry.relPath);
          const localText = await readLocalText(ctx.app, entry.relPath);
          const record = state.docRecords[entry.relPath];
          if (await options.isEditorDirty(entry.relPath)) throw new Error("笔记正在编辑，请保存后重新预览");
          if (entry.localHash !== undefined && await ctx.hashText(localText) !== entry.localHash) {
            throw new Error("预览后本地正文已改变，请重新预览");
          }
          const existingDocumentId = entry.action === "push" ? (entry.documentId ?? record?.documentId) : undefined;
          if (existingDocumentId && !entry.forceOverwrite) {
            // 覆盖前仍重新读取远端，防止预览后他人修改；缓存只用于拉取和映射，不用于写前安全校验。
            const remoteNow = await fetchFresh(existingDocumentId);
            if (await ctx.hashFetched(remoteNow) !== (entry.remoteHash ?? record?.baseRemoteHash)) {
              throw new Error("预览后飞书正文已改变，已停止覆盖，请重新同步处理远端改动");
            }
          }
          const decided = record?.documentTitle
            ? { title: record.documentTitle, renamed: false }
            : uniqueDocumentTitle(documentTitleFor(entry.relPath, settings), ctx.containerTitles);
          const ruleContext: RuleContext = {
            relPath: entry.relPath,
            documentTitle: decided.title,
            localContent: localText,
            resolveImage: ctx.resolveImage,
            imageUploads: [],
            attachmentLinkStyle: settings.attachmentLinkStyle,
            warnings: [],
          };
          const sent = applyRules("toFeishu", localText, ruleContext, ctx.rules);
          const parentNode = await resolveFolderNode(entry.parentDir);

          let documentId: string;
          let newBlocks: DocNewBlock[] = [];
          let revisionId: number | undefined;
          if (existingDocumentId) {
            const updated = await updateDocumentFromMarkdown(ctx.client, existingDocumentId, { title: decided.title, markdown: sent });
            documentId = existingDocumentId;
            newBlocks = updated.newBlocks;
            revisionId = updated.revisionId;
          } else {
            // docs_ai 建出来的是云空间文档，要先建再 move 进知识库
            const created = await createDocumentFromMarkdown(ctx.client, {
              title: decided.title,
              markdown: sent,
              onProgress: reportProgress,
            });
            await moveDocToWiki(ctx.client, ctx.spaceId, parentNode, created.documentId, "docx");
            documentId = created.documentId;
            newBlocks = created.newBlocks;
            revisionId = created.revisionId;
            if (decided.renamed) {
              ctx.logger.info(`笔记 ${entry.relPath} 与同名目录撞名，文档标题改为「${decided.title}」`);
            }
          }

          const images = await finalizeDocumentImages(ctx, {
            relPath: entry.relPath,
            documentId,
            newBlocks,
            revisionId,
            uploads: ruleContext.imageUploads ?? [],
          });
          for (const warning of ruleContext.warnings ?? []) ctx.logger.warn(`转换：${entry.relPath} ${warning}`);

          // 远端基线必须记"取回形态"：飞书会规范化格式，记发送形态下次一定判定远端变了
          const fetched = await fetchFresh(documentId);
          const remoteHash = await ctx.hashFetched(fetched);
          ctx.logger.debug(
            `${entry.relPath}: 取回形态与发送形态${fetched === buildMarkdownContent(decided.title, sent) ? "一致" : "不同（飞书做了格式化，基线以取回形态为准）"}`,
          );
          const statAfter = localStat(ctx.app, entry.relPath);
          const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
          const nodeToken =
            record?.nodeToken ?? (await getNodeByToken(ctx.client, documentId, "docx").catch(() => undefined))?.node_token;
          state.docRecords[entry.relPath] = {
            documentId,
            nodeToken,
            parentNodeToken: parentNode,
            documentTitle: decided.title,
            baseLocalHash: await ctx.hashText(localText),
            baseRemoteHash: remoteHash,
            publishRulesFingerprint: images.failures.length ? undefined : publishRulesFingerprint(ctx.rules),
            remoteModifiedTime: undefined,
            localSize: stable ? statAfter.size : -1,
            localMtime: stable ? statAfter.mtime : -1,
            lastSyncedAt: Date.now(),
          };
          delete state.conflicts[entry.relPath];
          reports.push({
            relPath: entry.relPath,
            action: entry.action,
            ok: images.failures.length === 0,
            message: buildUploadMessage(localText, images, ruleContext.warnings ?? []),
          });
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
        const record = state.docRecords[entry.relPath];
        const documentId = entry.documentId ?? record?.documentId;
        if (!documentId) {
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: "缺少远端 document_id" });
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

          const fetched = await fetchedFor(documentId);
          const localTextBefore = present ? await readLocalText(ctx.app, entry.relPath) : "";
          const imageWarnings: string[] = [];
          const imageDownloads = await prepareRemoteImages(ctx, fetched, {
            documentId,
            relPath: entry.relPath,
            warnings: imageWarnings,
          });
          const pulled = applyRules(
            "toObsidian",
            fetched,
            {
              relPath: entry.relPath,
              documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
              localContent: localTextBefore,
              attachmentLinkStyle: settings.attachmentLinkStyle,
              imageDownloads,
              warnings: imageWarnings,
            },
            ctx.rules,
          );
          const remoteHash = await ctx.hashFetched(fetched);
          for (const warning of imageWarnings) ctx.logger.warn(`图片：${entry.relPath} ${warning}`);

          // 计划生成到写盘之间用户可能已保存新改动，写盘前必须复核
          if (present && (entry.localSize !== undefined || entry.localMtime !== undefined)) {
            const before = localStat(ctx.app, entry.relPath);
            const movedSincePlan = before.size !== entry.localSize || before.mtime !== entry.localMtime;
            if (movedSincePlan) {
              const currentText = await readLocalText(ctx.app, entry.relPath);
              if (currentText !== pulled) {
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
              state.docRecords[entry.relPath] = {
                documentId,
                nodeToken: entry.nodeToken ?? record?.nodeToken,
                parentNodeToken: record?.parentNodeToken,
                documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
                baseLocalHash: await ctx.hashText(currentText),
                baseRemoteHash: remoteHash,
                publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
                remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
                localSize: before.size,
                localMtime: before.mtime,
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

          const presentNow = existsLocally(ctx.app, entry.relPath);
          if (presentNow !== present || (presentNow && (await options.isEditorDirty(entry.relPath) ||
              (entry.localHash !== undefined && await ctx.hashText(await readLocalText(ctx.app, entry.relPath)) !== entry.localHash)))) {
            throw new Error("下载期间本地笔记已改变，未覆盖，请重新同步");
          }
          // 纯排版差异保留本地布局，仅修复 Obsidian 必需的公式空白与转义
          if (
            present &&
            localTextBefore !== pulled &&
            sameAfterCosmeticRules(
              localTextBefore,
              pulled,
              {
                relPath: entry.relPath,
                documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
                localContent: localTextBefore,
              },
              ctx.rules,
            )
          ) {
            const localText = normalizeObsidianMath(localTextBefore, ctx.rules);
            const repaired = localText !== localTextBefore;
            if (repaired) await writeLocalBytes(ctx.app, entry.relPath, encodeText(localText));
            const stat = localStat(ctx.app, entry.relPath);
            state.docRecords[entry.relPath] = {
              documentId,
              nodeToken: entry.nodeToken ?? record?.nodeToken,
              parentNodeToken: record?.parentNodeToken,
              documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
              baseLocalHash: await ctx.hashText(localText),
              baseRemoteHash: remoteHash,
              publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
              remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
              localSize: stat.size,
              localMtime: stat.mtime,
              lastSyncedAt: Date.now(),
            };
            delete state.conflicts[entry.relPath];
            reports.push({ relPath: entry.relPath, action: repaired ? "pull" : "link", ok: true,
              message: repaired ? "已修复 Obsidian 公式定界符内侧空白或转义，保留本地段落排版" : "远端差异只是排版归一化，本地未改动" });
            tick(`${repaired ? "修复公式" : "跳过"} ${entry.relPath}`);
            return;
          }

          if (entry.action === "create-local" && present) {
            const currentText = await readLocalText(ctx.app, entry.relPath);
            if (currentText !== pulled) {
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

          await writeLocalBytes(ctx.app, entry.relPath, encodeText(pulled));
          const stat = localStat(ctx.app, entry.relPath);
          state.docRecords[entry.relPath] = {
            documentId,
            nodeToken: entry.nodeToken ?? record?.nodeToken,
            parentNodeToken: record?.parentNodeToken,
            documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
            baseLocalHash: await ctx.hashText(pulled),
            baseRemoteHash: remoteHash,
            publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
            remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
            localSize: stat.size,
            localMtime: stat.mtime,
            lastSyncedAt: Date.now(),
          };
          delete state.conflicts[entry.relPath];
          reports.push({
            relPath: entry.relPath,
            action: entry.action,
            ok: true,
            message: imageWarnings.length > 0 ? imageWarnings.join("；") : undefined,
          });
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
        const localText = await readLocalText(ctx.app, entry.relPath);
        const statAfter = localStat(ctx.app, entry.relPath);
        const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
        const existing = state.docRecords[entry.relPath];
        const documentId = entry.documentId ?? existing?.documentId ?? "";
        if (await options.isEditorDirty(entry.relPath) || await ctx.hashText(localText) !== entry.localHash ||
            await ctx.hashFetched(await fetchFresh(documentId)) !== entry.remoteHash) {
          throw new Error("预览后内容已改变，未更新映射，请重新同步");
        }
        state.docRecords[entry.relPath] = {
          documentId,
          nodeToken: entry.nodeToken ?? existing?.nodeToken,
          parentNodeToken: existing?.parentNodeToken,
          documentTitle: existing?.documentTitle ?? documentTitleFor(entry.relPath, settings),
          baseLocalHash: entry.localHash ?? (await ctx.hashText(localText)),
          baseRemoteHash: entry.remoteHash ?? existing?.baseRemoteHash ?? "",
          publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
          remoteModifiedTime: entry.remoteModifiedTime ?? existing?.remoteModifiedTime,
          localSize: stable ? statAfter.size : -1,
          localMtime: stable ? statAfter.mtime : -1,
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
      // 手动合并不是同步完成：保留基线与冲突标记，下轮仍提示，直到用户明确推送或拉取。
      const record = state.docRecords[entry.relPath];
      if (record) record.conflict = true;
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

  await mapConcurrent(steps, 3, (step) => step());

  // 删除放在上传/拉取之后：先删后建会在远端留下同名冲突
  if (options.allowPush) {
    for (const entry of remoteDeletes) {
      const record = state.docRecords[entry.relPath];
      const documentId = entry.documentId ?? record?.documentId;
      const title = entry.remoteTitle ?? record?.documentTitle ?? entry.relPath;
      if (!documentId) {
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: "缺少远端 document_id，未删除" });
        tick(`跳过删除 ${entry.relPath}`);
        continue;
      }
      try {
        if (existsLocally(ctx.app, entry.relPath) || await options.isEditorDirty(entry.relPath)) {
          throw new Error("本地笔记已恢复或正在编辑，未删除远端，请重新预览");
        }
        const remoteHashNow = await ctx.hashFetched(await fetchFresh(documentId));
        if (!record || remoteHashNow !== record.baseRemoteHash) {
          throw new Error("飞书内容在预览后已改变，未删除，请重新同步");
        }
        if (existsLocally(ctx.app, entry.relPath) || await options.isEditorDirty(entry.relPath)) {
          throw new Error("检查期间本地笔记已恢复，未删除远端");
        }
        await deleteDriveFile(ctx.client, documentId, "docx");
        delete state.docRecords[entry.relPath];
        delete state.conflicts[entry.relPath];
        ctx.logger.info(`已删除远端文档 ${title}（${documentId}），进飞书回收站可恢复`);
        reports.push({
          relPath: entry.relPath,
          action: "delete-remote",
          ok: true,
          message: `已删除远端文档「${title}」（进飞书回收站，可恢复）`,
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
          await assertRemoteAbsent(ctx.client, ctx.spaceId, ctx.rootNodeToken, state.docRecords[entry.relPath]?.documentId);
          if (await options.isEditorDirty(entry.relPath) || !entry.localHash || await ctx.hashText(await readLocalText(ctx.app, entry.relPath)) !== entry.localHash) {
            throw new Error("本地笔记在预览后已改变，未删除，请重新同步");
          }
          await ctx.app.vault.trash(file, false);
        }
        delete state.docRecords[entry.relPath];
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

  for (const entry of observed) {
    if (entry.action === "forget") {
      delete state.docRecords[entry.relPath];
      delete state.conflicts[entry.relPath];
    }
    reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
  }

  state.lastSyncAt = Date.now();
  // 时间戳校验通过的文档把时间戳写回记录，下一轮走快路径
  for (const entry of plan.items) {
    const record = state.docRecords[entry.relPath];
    if (entry.action === "skip" && record && entry.remoteModifiedTime && entry.remoteHash === record.baseRemoteHash) {
      record.remoteModifiedTime = entry.remoteModifiedTime;
    }
  }
  return reports;
}

const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/webp": ".webp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
};

interface FinalizeImagesResult {
  uploaded: number;
  reused: number;
  failures: string[];
  cleaned: number;
}

/** 上行编排：关联占位块 → 复用/上传 → 绑定（失败则清理占位，不留标记在文档里）。 */
async function finalizeDocumentImages(
  ctx: DocExecutionContext,
  options: { relPath: string; documentId: string; newBlocks: DocNewBlock[]; revisionId?: number; uploads: LocalImageUpload[] },
): Promise<FinalizeImagesResult> {
  const result: FinalizeImagesResult = { uploaded: 0, reused: 0, failures: [], cleaned: 0 };
  if (options.uploads.length === 0) return result;

  const byMarker = correlateImageBlocks(options.newBlocks, options.uploads.map((upload) => upload.marker));
  const failedBlocks: string[] = [];

  for (const upload of options.uploads) {
    const blockId = byMarker.get(upload.marker);
    if (!blockId) {
      result.failures.push(`${upload.fileName}：服务端没有返回对应的图片占位块`);
      continue;
    }
    try {
      const bytes = await ctx.readBinary(upload.vaultPath);
      const hash = await ctx.hashBytes(bytes);
      const cacheKey = `${hash}:${options.documentId}`;
      const cached = ctx.state.imageUploads[cacheKey];
      if (cached?.fileToken) {
        // 复用前必须回读确认 token 真的绑上了，确认不了就重新上传
        try {
          await bindDocImages(ctx.client, options.documentId, [{ blockId, fileToken: cached.fileToken }]);
          const bound = await getDocBlockToken(ctx.client, options.documentId, blockId);
          if (bound === cached.fileToken) {
            result.reused += 1;
            continue;
          }
          ctx.logger.warn(`图片 ${upload.fileName} 复用已上传素材失败（回读到的 token 不一致），改为重新上传`);
        } catch (error) {
          ctx.logger.warn(`图片 ${upload.fileName} 复用已上传素材报错，改为重新上传：${describeError(error)}`);
        }
        delete ctx.state.imageUploads[cacheKey];
      }
      const fileToken = await uploadDocImage(ctx.client, {
        documentId: options.documentId,
        blockId,
        fileName: upload.fileName,
        bytes,
      });
      await bindDocImages(ctx.client, options.documentId, [{ blockId, fileToken }]);
      ctx.state.imageUploads[cacheKey] = { fileToken, documentId: options.documentId, hash, path: upload.vaultPath, at: Date.now() };
      // 记下 token ↔ 本地路径，之后取回同一张图不用再下载
      ctx.state.images[fileToken] = { path: upload.vaultPath, token: fileToken, hash, at: Date.now() };
      result.uploaded += 1;
    } catch (error) {
      ctx.logger.error(`图片 ${upload.fileName} 上传/绑定失败：${describeError(error)}`);
      result.failures.push(`${upload.fileName}：${describeError(error)}`);
      failedBlocks.push(blockId);
    }
  }

  if (failedBlocks.length > 0) {
    try {
      await deleteDocBlocks(ctx.client, options.documentId, failedBlocks, options.revisionId);
      result.cleaned = failedBlocks.length;
      ctx.logger.warn(`已清理 ${failedBlocks.length} 个图片占位块（对应图片没上传成功，本地引用不受影响）`);
    } catch (error) {
      ctx.logger.warn(`清理图片占位块失败，文档里可能残留占位：${describeError(error)}`);
    }
  }
  return result;
}

function buildUploadMessage(localText: string, images: FinalizeImagesResult, warnings: string[]): string | undefined {
  const parts: string[] = [];
  if (localText.length === 0) parts.push("空笔记在文档模式也会同步：正文为空，飞书侧只有标题（md 模式会跳过空文件）");
  if (images.uploaded > 0 || images.reused > 0) parts.push(`图片：新上传 ${images.uploaded} 张、复用已上传 ${images.reused} 张`);
  if (images.failures.length > 0) {
    parts.push(`图片失败 ${images.failures.length} 张（已清理占位块 ${images.cleaned} 个）：${images.failures.join("；")}`);
  }
  if (warnings.length > 0) parts.push(warnings.join("；"));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function extensionFor(contentType: string | undefined, url: string, alt: string): string {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (IMAGE_MIME_EXT[mime]) return IMAGE_MIME_EXT[mime];
  for (const candidate of [url, alt]) {
    const match = /\.(png|jpe?g|gif|bmp|webp|tiff?|svg)(?:[?#]|$)/i.exec(candidate);
    if (match) return `.${match[1].toLowerCase().replace(/^jpeg$/, "jpg")}`;
  }
  return ".png";
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function attachmentName(token: string, alt: string, ext: string): string {
  const altName = alt.trim();
  if (altName && !/[\\/:\x00-\x1f\[\]|]/.test(altName) && /\.(png|jpe?g|gif|bmp|webp|tiff?|svg)$/i.test(altName)) return altName;
  return `image-${token.slice(-8)}${ext}`;
}

function withSuffix(name: string, index: number): string {
  const match = /^(.*?)(\.[^.]*)?$/.exec(name);
  const stem = match?.[1] ?? name;
  const suffix = match?.[2] ?? "";
  return `${stem}-${index}${suffix}`;
}

/** 附件落盘路径：同名同内容复用，同名不同内容加后缀（同一 token 再次拉取会先命中 state 里的映射）。 */
async function resolveAttachmentPath(
  ctx: DocExecutionContext,
  folder: string,
  name: string,
  bytes: ArrayBuffer,
): Promise<string | undefined> {
  const join = (fileName: string): string => (folder ? `${folder}/${fileName}` : fileName);
  const primary = join(name);
  if (!existsLocally(ctx.app, primary)) return primary;
  try {
    if (bytesEqual(await ctx.readBinary(primary), bytes)) return primary;
  } catch (error) {
    ctx.logger.warn(`读取已有附件 ${primary} 失败，按新文件处理：${describeError(error)}`);
  }
  for (let index = 1; index < 100; index += 1) {
    const candidate = join(withSuffix(name, index));
    if (!existsLocally(ctx.app, candidate)) return candidate;
  }
  return undefined;
}

/** 按内容哈希找一份已经在本地的等价文件（下载过的附件，或上传用的原图）。 */
async function knownImagePath(ctx: DocExecutionContext, hash: string): Promise<string | undefined> {
  for (const record of [...Object.values(ctx.state.images), ...Object.values(ctx.state.imageUploads)]) {
    if (record.hash === hash && record.path && existsLocally(ctx.app, record.path) &&
        await ctx.hashBytes(await ctx.readBinary(record.path)) === hash) return record.path;
  }
  return undefined;
}

async function downloadRemoteImage(
  ctx: DocExecutionContext,
  options: { token: string; alt: string; url: string; warnings: string[] },
): Promise<string | undefined> {
  try {
    const downloaded = await downloadDocMedia(ctx.client, options.token);
    if (downloaded.bytes.byteLength > REMOTE_IMAGE_MAX_BYTES) {
      options.warnings.push(`素材 ${options.token} 超过 20MB，已跳过（引用保持原样）`);
      return undefined;
    }
    const hash = await ctx.hashBytes(downloaded.bytes);
    // 同一份内容直接复用已有文件，别再存一份副本
    const known = await knownImagePath(ctx, hash);
    if (known) {
      ctx.state.images[options.token] = { path: known, token: options.token, hash, at: Date.now() };
      ctx.logger.debug(`远端图片 ${options.token} 与本地已有文件内容一致，复用 ${known}`);
      return known;
    }
    const folder = ctx.settings.attachmentFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const ext = extensionFor(downloaded.contentType, options.url, options.alt);
    const name = attachmentName(options.token, options.alt, ext);
    const path = await resolveAttachmentPath(ctx, folder, name, downloaded.bytes);
    if (!path) {
      options.warnings.push(`附件 ${name} 同名文件过多，未落盘（引用保持原样）`);
      return undefined;
    }
    if (!existsLocally(ctx.app, path)) await writeLocalBytes(ctx.app, path, downloaded.bytes);
    ctx.state.images[options.token] = { path, token: options.token, hash, at: Date.now() };
    ctx.logger.info(`已下载远端图片 ${options.token} → ${path}`);
    return path;
  } catch (error) {
    ctx.logger.warn(`下载素材 ${options.token} 失败：${describeError(error)}`);
    options.warnings.push(`第 ${options.token} 张图下载失败（${describeError(error)}），引用保持原样`);
    return undefined;
  }
}

/** 下行编排：解析取回内容里的图片 → 下载到附件目录 → 交给 image-download 规则改写。 */
async function prepareRemoteImages(
  ctx: DocExecutionContext,
  fetched: string,
  options: { documentId: string; relPath: string; warnings: string[] },
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ruleEnabled(ctx.rules, "toObsidian", "image-download")) return map;
  const refs: RemoteImageRef[] = collectRemoteImages(fetched);
  if (refs.length === 0) return map;

  // URL 里带素材 token 就直接用；带不上就用文档图片块按顺序对应（数量不一致就不猜，宁可保持原样）
  let blocks: DocImageBlock[] | undefined;
  if (refs.some((ref) => !ref.token)) {
    try {
      const listed = await listDocImageBlocks(ctx.client, options.documentId);
      if (listed.length === refs.length) {
        blocks = listed;
      } else {
        options.warnings.push(
          `取回内容里有 ${refs.length} 张图，但文档里读到 ${listed.length} 个图片块，数量不一致，未按顺序匹配（这些图片保持原样）`,
        );
      }
    } catch (error) {
      options.warnings.push(`读取文档图片块失败，无法解析图片素材：${describeError(error)}`);
    }
  }

  const pathByToken = new Map<string, string>();
  for (const ref of refs) {
    const token = ref.token ?? blocks?.[ref.index]?.fileToken;
    if (!token) {
      options.warnings.push(`第 ${ref.index + 1} 张图拿不到素材 token，引用保持原样`);
      continue;
    }
    let localPath = pathByToken.get(token);
    if (!localPath) {
      const known = ctx.state.images[token];
      if (known?.hash && existsLocally(ctx.app, known.path) && await ctx.hashBytes(await ctx.readBinary(known.path)) === known.hash) {
        localPath = known.path;
      } else {
        localPath = await downloadRemoteImage(ctx, { token, alt: ref.alt, url: ref.url, warnings: options.warnings });
      }
      if (localPath) pathByToken.set(token, localPath);
    }
    if (localPath) map.set(ref.raw, localPath);
  }
  return map;
}
