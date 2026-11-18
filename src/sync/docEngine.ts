import { FeishuClient } from "../feishu/client";
import { fetchDocumentMarkdown } from "../feishu/docs";
import { batchQueryMetas } from "../feishu/files";
import { walkWikiTree } from "../feishu/wiki";
import type { ResolvedImage, RulesFile } from "../convert/rules";
import { loadRules, normalizeRemoteImageUrls, publishRulesFingerprint, pullRulesFingerprint } from "../convert/rules";
import type { DocPlanCache, DocRemoteIndex } from "./docPlanner";
import { buildDocPlan, buildDocRemoteIndex, createDocPlanCache } from "./docPlanner";
import type { DocExecutionContext } from "./docExecutor";
import { executeDocPlan, readLocalText } from "./docExecutor";
import type { EngineDeps, PlanDecision, RunOptions, RunResult } from "./engine-base";
import { BaseSyncEngine, parseTokenFromInput } from "./engine-base";
import { applyPlanOverrides, assertPlanCurrent, deferDeletes, filterPlan, isEditorDirty, planFingerprint, prepareTarget, validateSettings, validateLocalPaths } from "./guards";
import { sha256Hex } from "./hash";
import type { ReportEntry } from "./executor";
import { PathFilter, readLocalBytes, scanLocalNotes } from "./scanner";
import type { LocalNote, PluginSettings, SyncPlan } from "./types";
import { basenameOf, dirnameOf } from "./types";

export class DocSyncEngine extends BaseSyncEngine {
  constructor(deps: EngineDeps) {
    super(deps);
  }

  protected async runInternal(options: RunOptions): Promise<RunResult> {
    const settings = this.deps.getSettings();
    const logger = this.deps.logger;
    validateSettings(settings);
    const spaceId = parseTokenFromInput(settings.spaceId);
    // 留空表示以知识空间顶层为同步根
    const rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || undefined;
    if (!spaceId) throw new Error("请先在插件设置里填写知识库 space_id");

    const client = this.createClient();
    const filter = new PathFilter(settings.excludePatterns);

    if (options.preApprovedPlan) assertPlanCurrent(options.preApprovedPlan, settings);
    if (prepareTarget(settings, spaceId, rootNodeToken ?? "", "doc")) {
      logger.warn("同步目标或模式已变更，已清空旧映射，本轮按首次对接判定");
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

      await this.recognizeRootContainer(client, settings, spaceId, rootNodeToken);

      options.onProgress?.("扫描本地笔记…");
      const local: Map<string, LocalNote> = scanLocalNotes(this.deps.app, filter);
      validateLocalPaths(local.keys(), settings);

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
      if (index.warnings.length) throw new Error(`远端路径存在歧义，请先处理再同步：${index.warnings.join("；")}`);
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
        fetchMarkdown: (documentId) => fetchDocumentMarkdown(client, documentId),
      });
      logger.debug(
        `文档模式：本轮 fetch 文档 ${cache.fetchCount} 次、批量元数据 ${remoteModifiedTimes.size > 0 ? "命中" : "未命中"}（${settings.docVerifyRemoteByContent ? "安全阀打开：每轮全文校验" : "时间戳快路径"}）`,
      );
      // 基线（含时间戳）只在批准的动作成功后才更新；与 md 模式一致：先按模式过滤计划
      const plan = deferDeletes(filterPlan(planned, options.mode), options.allowDeletes);

      plan.settingsFingerprint = planFingerprint(settings);
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

  /** 远端基线用"取回形态 + 图片 URL 归一化"：URL 里带会过期的签名，不归一化会天天判成远端变了。 */
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
      } else if (typeof decision === "object") {
        planForRun = applyPlanOverrides(plan, decision.actions);
      }
    }

    assertPlanCurrent(plan, context.settings);
    const cache = context.cache ?? createDocPlanCache();
    const local: Map<string, LocalNote> = scanLocalNotes(this.deps.app, context.filter);
    // 建文档时要避开与容器（目录页面）撞名
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
        isEditorDirty: (relPath) => isEditorDirty(this.deps.app, relPath),
        onProgress: (message, done, total) => options.onProgress?.(`${message}（${done}/${total}）`),
      });
      // 触碰过的文档刷新一次修改时间，下一轮才能走快路径
      const touched = touchedRelPaths(report);
      if (touched.size > 0) await this.refreshDocumentModifyTimes(context.client, context.settings.state, touched);
      return { plan: planForRun, report, executed: true };
    } finally {
      // 中途失败也要落盘已完成的部分
      await this.deps.saveSettings();
    }
  }

  /** 批量取「最后修改时间」（Unix 秒字符串）；取不到就返回空，调用方退回逐篇取回校验。 */
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
