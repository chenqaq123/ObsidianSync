import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { AuthManager } from "../feishu/auth";
import { FeishuClient } from "../feishu/client";
import { fetchDocumentMarkdown } from "../feishu/docs";
import { batchQueryMetas } from "../feishu/files";
import type { WikiSpace } from "../feishu/wiki";
import { listNodes, listSpaces, walkWikiTree } from "../feishu/wiki";
import type { Logger } from "../log";
import type { ResolvedImage, RulesFile } from "../convert/rules";
import { loadRules, normalizeRemoteImageUrls, publishRulesFingerprint, pullRulesFingerprint } from "../convert/rules";
import type { DocPlanCache, DocRemoteIndex } from "./docPlanner";
import { buildDocPlan, buildDocRemoteIndex, createDocPlanCache } from "./docPlanner";
import type { DocExecutionContext } from "./docExecutor";
import { executeDocPlan, readLocalText } from "./docExecutor";
import type { PlanDecision, RunOptions, RunResult, SyncMode } from "./engine";
import { parseTokenFromInput } from "./engine";
import { sha256Hex } from "./hash";
import type { ReportEntry } from "./executor";
import { PathFilter, readLocalBytes, scanLocalNotes } from "./scanner";
import type { LocalNote, PlanItem, PluginSettings, SyncPlan } from "./types";
import { basenameOf, dirnameOf } from "./types";

export interface DocEngineDeps {
  app: App;
  getSettings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  auth: AuthManager;
  logger: Logger;
}

export class DocSyncEngine {
  private syncing = false;

  constructor(private readonly deps: DocEngineDeps) {}

  isSyncing(): boolean {
    return this.syncing;
  }

  createClient(): FeishuClient {
    return new FeishuClient((force) => this.deps.auth.getToken(force), this.deps.logger);
  }

  async listSpaces(): Promise<WikiSpace[]> {
    return listSpaces(this.createClient());
  }

  async run(options: RunOptions): Promise<RunResult> {
    if (this.syncing) throw new Error("已有同步任务在执行中");
    this.syncing = true;
    try {
      return await this.runInternal(options);
    } finally {
      this.syncing = false;
    }
  }

  private async runInternal(options: RunOptions): Promise<RunResult> {
    const settings = this.deps.getSettings();
    const logger = this.deps.logger;
    const spaceId = parseTokenFromInput(settings.spaceId);
    // 留空表示以知识空间顶层为同步根：vault 的一级目录会成为知识库的一级页面
    const rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || undefined;
    if (!spaceId) throw new Error("请先在插件设置里填写知识库 space_id");

    const client = this.createClient();
    const filter = new PathFilter(settings.excludePatterns);

    const previousTarget = settings.state.target;
    if (
      !previousTarget ||
      previousTarget.spaceId !== spaceId ||
      previousTarget.rootNodeToken !== (rootNodeToken ?? "") ||
      previousTarget.syncMode !== "doc"
    ) {
      if (previousTarget) {
        logger.warn(
          `文档模式的同步目标已变更（${previousTarget.spaceId}/${previousTarget.rootNodeToken || "顶层"}/${previousTarget.syncMode ?? "md"} → ${spaceId}/${rootNodeToken ?? "顶层"}/doc），已清空文档映射表，本轮按"首次对接"重新判定，不会直接覆盖本地`,
        );
        settings.state.docRecords = {};
        settings.state.conflicts = {};
      }
      settings.state.target = { spaceId, rootNodeToken: rootNodeToken ?? "", syncMode: "doc" };
    }

    try {
      const rules = await this.rules();
      if (options.preApprovedPlan) {
        if (options.preApprovedPlan.publishRulesFingerprint !== publishRulesFingerprint(rules) ||
            options.preApprovedPlan.pullRulesFingerprint !== pullRulesFingerprint(rules)) {
          throw new Error("预览后转换规则发生变化，请重新预览同步计划");
        }
        const plan = filterPlan(options.preApprovedPlan, options.mode);
        return await this.execute(plan, options, { settings, client, spaceId, rootNodeToken, filter, rules });
      }

      // 状态丢失（清空状态、换机器、新装插件指向同一个知识库）时，先按标题认出已有的根目录页面
      if (!rootNodeToken && !settings.state.folders[""]?.nodeToken) {
        const title = settings.rootPageTitle.trim() || this.deps.app.vault.getName();
        try {
          const topLevel = await listNodes(client, spaceId);
          const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
          if (found?.node_token) {
            settings.state.folders[""] = { nodeToken: found.node_token };
            logger.info(`识别到已有的知识库顶层页面「${title}」，复用它存放 vault 根目录下的笔记`);
          }
        } catch (error) {
          logger.warn(`查找知识库顶层页面失败，根目录下的笔记可能被识别成新文档：${String(error)}`);
        }
      }

      options.onProgress?.("扫描本地笔记…");
      const local: Map<string, LocalNote> = scanLocalNotes(this.deps.app, filter);

      options.onProgress?.("读取飞书知识库节点树…");
      const entries = await walkWikiTree(client, spaceId, rootNodeToken, {
        rootContainerNode: settings.state.folders[""]?.nodeToken,
        onProgress: (visited) => {
          if (visited % 50 === 0) options.onProgress?.(`读取飞书知识库节点树…（已见 ${visited} 个节点）`);
        },
      });
      const index = buildDocRemoteIndex({
        entries,
        state: settings.state,
        folderMode: settings.folderMode,
        flatSeparator: settings.flatSeparator,
        rootContainerNode: settings.state.folders[""]?.nodeToken,
        isExcluded: (relPath) => filter.isExcluded(relPath),
      });
      for (const warning of index.warnings) logger.warn(`文档模式：${warning}`);
      // 认出目录节点就登记下来，后续轮次不必再靠结构推断，也不会重复建页面
      if (settings.folderMode === "nodes") {
        for (const [relDir, container] of index.containers) {
          const known = settings.state.folders[relDir];
          if (!known || known.nodeToken !== container.nodeToken) {
            settings.state.folders[relDir] = { nodeToken: container.nodeToken, parentNodeToken: container.parentNodeToken };
          }
        }
      }
      logger.info(
        `文档模式：远端识别到 ${index.notes.size} 篇文档、${index.containers.size} 个目录节点；本地 ${local.size} 篇笔记`,
      );

      options.onProgress?.("读取远端文档元数据…");
      const remoteModifiedTimes = settings.docVerifyRemoteByContent
        ? new Map<string, string>()
        : await this.batchDocumentModifyTimes(client, settings.state);
      if (remoteModifiedTimes.size === 0 && Object.keys(settings.state.docRecords).length > 0) {
        logger.debug("文档模式：没拿到可用的远端修改时间，本轮退回逐篇取回校验");
      }
      if (settings.docVerifyRemoteByContent) {
        logger.debug("文档模式：已打开「每轮取回全文校验」，本轮忽略修改时间戳");
      }

      const cache = createDocPlanCache();
      const planned = await buildDocPlan({
        state: settings.state,
        local,
        remote: index,
        settings,
        rules,
        isExcluded: (relPath) => filter.isExcluded(relPath),
        recreateRemoteIfDeleted: settings.recreateRemoteIfDeleted,
        propagateLocalDelete: settings.propagateLocalDelete,
        propagateRemoteDelete: settings.propagateRemoteDelete,
        cache,
        forcePush: options.forcePush === true,
        remoteModifiedTimes,
        verifyRemoteByContent: settings.docVerifyRemoteByContent,
        readLocal: (relPath) => readLocalText(this.deps.app, relPath),
        hashText: (text) => this.hashText(text),
        hashFetched: (text) => this.hashFetched(text),
        fetchMarkdown: (documentId) => this.fetchMarkdown(client, documentId),
      });
      logger.debug(
        `文档模式：本轮 fetch 文档 ${cache.fetchCount} 次、批量元数据 ${remoteModifiedTimes.size > 0 ? "命中" : "未命中"}（${settings.docVerifyRemoteByContent ? "安全阀打开：每轮全文校验" : "时间戳快路径"}）`,
      );
      // Baselines, including timestamps, are updated only after the approved action succeeds.
      // 与 md 模式一致：先按本次模式过滤计划，预览/报告里只出现真的会执行的动作
      const plan = filterPlan(planned, options.mode);

      if (options.dryRun) {
        return { plan, report: [], executed: false };
      }
      return await this.execute(plan, options, { settings, client, spaceId, rootNodeToken, filter, rules, cache, index });
    } catch (error) {
      await this.deps.saveSettings();
      throw error;
    }
  }

  private async rules(): Promise<RulesFile> {
    return loadRules(this.deps.app.vault.adapter, this.deps.logger);
  }

  private async hashText(text: string): Promise<string> {
    return sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
  }

  /** 远端基线用"取回形态 + 图片 URL 归一化"：图片 URL 里可能带会过期的签名，不归一化会天天判成远端变了。 */
  private async hashFetched(text: string): Promise<string> {
    return this.hashText(normalizeRemoteImageUrls(text));
  }

  private async hashBytes(bytes: ArrayBuffer): Promise<string> {
    return sha256Hex(bytes);
  }

  /** 上行：用 Obsidian 的链接解析把 ![[x.png]] / ![](path) 还原成 vault 里的真实文件 */
  private imageResolver(): (linkpath: string, sourcePath: string) => ResolvedImage | undefined {
    return (linkpath, sourcePath) => {
      const cache = this.deps.app.metadataCache as { getFirstLinkpathDest?: (linkpath: string, sourcePath: string) => { path: string; stat?: { size: number } } | null } | undefined;
      const target = cache?.getFirstLinkpathDest?.(linkpath, sourcePath);
      if (!target) return undefined;
      return { path: target.path, size: target.stat?.size ?? 0 };
    };
  }

  private async fetchMarkdown(client: FeishuClient, documentId: string): Promise<string> {
    return fetchDocumentMarkdown(client, documentId);
  }

  private async execute(
    plan: SyncPlan,
    options: RunOptions,
    context: {
      settings: PluginSettings;
      client: FeishuClient;
      spaceId: string;
      rootNodeToken?: string;
      filter: PathFilter;
      rules: RulesFile;
      cache?: DocPlanCache;
      index?: DocRemoteIndex;
    },
  ): Promise<RunResult> {
    let allowPush = options.mode !== "pull";
    const allowPull = options.mode !== "push";
    let planForRun = plan;
    if (options.confirm) {
      const decision: PlanDecision = await options.confirm(plan);
      if (decision === "cancel") return { plan, report: [], executed: false };
      if (decision === "pull-only") {
        allowPush = false;
        planForRun = filterPlan(plan, "pull");
      }
    }

    const cache = context.cache ?? createDocPlanCache();
    const local: Map<string, LocalNote> = scanLocalNotes(this.deps.app, context.filter);
    // 建文档时要避开与容器（目录页面）撞名：远端已认出的容器 + 状态里的目录 + 本地目录名
    const containerTitles = new Set<string>(context.index?.containerTitles ?? []);
    for (const relDir of Object.keys(context.settings.state.folders)) {
      if (relDir) containerTitles.add(basenameOf(relDir));
    }
    for (const relPath of local.keys()) {
      for (const segment of dirnameOf(relPath).split("/").filter(Boolean)) containerTitles.add(segment);
    }

    const execContext: DocExecutionContext = {
      app: this.deps.app,
      client: context.client,
      settings: context.settings,
      state: context.settings.state,
      logger: this.deps.logger,
      spaceId: context.spaceId,
      rootNodeToken: context.rootNodeToken,
      rules: context.rules,
      cache,
      containerTitles,
      hashText: (text) => this.hashText(text),
      hashFetched: (text) => this.hashFetched(text),
      hashBytes: (bytes) => this.hashBytes(bytes),
      resolveImage: this.imageResolver(),
      readBinary: (vaultPath) => readLocalBytes(this.deps.app, vaultPath),
    };

    try {
      const report: ReportEntry[] = await executeDocPlan(planForRun, execContext, {
        allowPush,
        allowPull,
        isEditorDirty: (relPath) => this.isEditorDirty(relPath),
        onProgress: (message, done, total) => options.onProgress?.(`${message}（${done}/${total}）`),
      });
      // 触碰过的文档刷新一次修改时间，下一轮才能走快路径
      const touched = touchedRelPaths(report);
      if (touched.size > 0) await this.refreshDocumentModifyTimes(context.client, context.settings.state, touched);
      return { plan: planForRun, report, executed: true };
    } finally {
      // 中途失败也要落盘已完成的部分，否则下次会按旧基线重新判断
      await this.deps.saveSettings();
    }
  }

  /** 批量取「最后修改时间」（Unix 秒字符串）：文档 id → 时间戳。取不到就返回空，调用方退回逐篇取回。 */
  private async batchDocumentModifyTimes(
    client: FeishuClient,
    state: { docRecords: Record<string, { documentId: string }> },
  ): Promise<Map<string, string>> {
    const tokens = Array.from(new Set(Object.values(state.docRecords).map((record) => record.documentId))).filter(Boolean);
    if (tokens.length === 0) return new Map();
    try {
      const metas = await batchQueryMetas(client, tokens, "docx");
      const times = new Map<string, string>();
      for (const [token, meta] of metas) {
        if (meta.modifiedTime) times.set(token, meta.modifiedTime);
      }
      return times;
    } catch (error) {
      this.deps.logger.warn(`批量读取远端文档元数据失败，本轮退回逐篇取回校验：${String(error)}`);
      return new Map();
    }
  }

  private async refreshDocumentModifyTimes(
    client: FeishuClient,
    state: { docRecords: Record<string, { documentId: string; remoteModifiedTime?: string }> },
    relPaths: Set<string>,
  ): Promise<void> {
    const tokens = Array.from(
      new Set([...relPaths].map((relPath) => state.docRecords[relPath]?.documentId).filter((token): token is string => Boolean(token))),
    );
    if (tokens.length === 0) return;
    try {
      const metas = await batchQueryMetas(client, tokens, "docx");
      for (const record of Object.values(state.docRecords)) {
        const meta = metas.get(record.documentId);
        if (meta?.modifiedTime) record.remoteModifiedTime = meta.modifiedTime;
      }
    } catch (error) {
      this.deps.logger.warn(`刷新远端文档修改时间失败（下一轮会退回逐篇取回）：${String(error)}`);
    }
  }

  private async isEditorDirty(relPath: string): Promise<boolean> {
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { file?: { path: string }; editor?: { getValue(): string } };
      if (view?.file?.path !== relPath || !view.editor) continue;
      const value = view.editor.getValue();
      const file = this.deps.app.vault.getAbstractFileByPath(relPath);
      if (file instanceof TFile) {
        const disk = await this.deps.app.vault.cachedRead(file);
        return value !== disk;
      }
      return value.length > 0;
    }
    return false;
  }
}

/** 本轮真的动过（写远端或写本地）的笔记：这些文档的修改时间需要刷新 */
function touchedRelPaths(report: ReportEntry[]): Set<string> {
  const touched = new Set<string>();
  for (const entry of report) {
    if (!entry.ok) continue;
    if (["push", "create-remote", "pull", "create-local", "link"].includes(entry.action)) touched.add(entry.relPath);
  }
  return touched;
}

function filterPlan(plan: SyncPlan, mode: SyncMode): SyncPlan {
  if (mode === "both") return plan;
  const items: PlanItem[] = plan.items.filter((entry) => {
    if (mode === "pull") return entry.action !== "push" && entry.action !== "create-remote" && entry.action !== "delete-remote";
    return entry.action !== "pull" && entry.action !== "create-local" && entry.action !== "delete-local";
  });
  const counts: Record<string, number> = {};
  for (const entry of items) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  return { ...plan, items, counts };
}
