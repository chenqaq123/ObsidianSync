import { batchQueryMetas, downloadFile } from "../feishu/files";
import { walkWikiTree } from "../feishu/wiki";
import { executePlan } from "./executor";
import { parseTokenFromInput, type EngineDeps, type RunOptions, type RunResult } from "./engine-base";
import { BaseSyncEngine } from "./engine-base";
import { applyPlanOverrides, assertPlanCurrent, deferDeletes, filterPlan, isEditorDirty, planFingerprint, prepareTarget, validateSettings, validateLocalPaths } from "./guards";
import { sha256Hex } from "./hash";
import { buildPlan } from "./planner";
import { PathFilter, assertSafeVaultPath, readLocalBytes, scanLocalNotes } from "./scanner";
import type { LocalNote, RemoteNote, SyncPlan } from "./types";
import { joinPath } from "./types";

export class SyncEngine extends BaseSyncEngine {
  constructor(deps: EngineDeps) {
    super(deps);
  }

  protected async runInternal(options: RunOptions): Promise<RunResult> {
    const settings = this.deps.getSettings();
    validateSettings(settings);
    const spaceId = parseTokenFromInput(settings.spaceId);
    // 留空表示以知识空间顶层为同步根
    const rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || undefined;
    if (!spaceId) throw new Error("请先在插件设置里填写知识库 space_id");

    const client = this.createClient();
    const logger = this.deps.logger;
    const filter = new PathFilter(settings.excludePatterns);

    if (options.preApprovedPlan) assertPlanCurrent(options.preApprovedPlan, settings);
    if (prepareTarget(settings, spaceId, rootNodeToken ?? "", "md")) {
      logger.warn("同步目标或模式已变更，已清空旧映射，本轮按首次对接判定");
    }

    try {
      let plan: SyncPlan;
      if (options.preApprovedPlan) {
        plan = filterPlan(options.preApprovedPlan, options.mode);
      } else {
        await this.recognizeRootContainer(client, settings, spaceId, rootNodeToken);

        options.onProgress?.("扫描本地笔记…");
        const local: Map<string, LocalNote> = scanLocalNotes(this.deps.app, filter);
        validateLocalPaths(local.keys(), settings);

        options.onProgress?.("读取飞书知识库节点树…");
        const tree = await walkWikiTree(client, spaceId, rootNodeToken, {
          rootContainerNode: settings.state.folders[""]?.nodeToken,
          onProgress: (visited) => {
            if (visited % 50 === 0) options.onProgress?.(`读取飞书知识库节点树…（已见 ${visited} 个节点）`);
          },
        });
        const remote: Map<string, RemoteNote> = new Map();
        // 大小写不敏感与 NFC/NFD 差异会让两个不同标题落到同一个物理文件上
        const seenPaths = new Map<string, string>();
        for (const entry of tree) {
          if (entry.objType !== "file") continue;
          if (entry.relDir && filter.isExcluded(entry.relDir)) continue;

          const raw = joinPath(entry.relDir, entry.title);
          const relPath = settings.folderMode === "flat" ? raw.split(settings.flatSeparator).join("/") : raw;
          if (filter.isExcluded(relPath)) continue;
          assertSafeVaultPath(relPath);

          if (relPath.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
            logger.warn(`远端标题包含非法路径片段，已跳过：${raw}`);
            continue;
          }
          const normalized = relPath.normalize("NFC").toLowerCase();
          const clash = seenPaths.get(normalized);
          if (clash === relPath) {
            throw new Error(`远端存在多个同名节点，已停止同步，请先在知识库中处理：${relPath}`);
          }
          if (clash && clash !== relPath) {
            throw new Error(`远端路径存在大小写或 Unicode 歧义，已停止同步：${relPath} / ${clash}`);
          }
          seenPaths.set(normalized, relPath);
          remote.set(relPath, { relPath, entry });
        }

        const modifiedTimes = new Map<string, string>();
        if (remote.size > 0) {
          options.onProgress?.("读取远端元数据…");
          const tokens = Array.from(remote.values()).map((note) => note.entry.objToken);
          try {
            const metas = await batchQueryMetas(client, tokens);
            for (const [token, meta] of metas) {
              if (meta.modifiedTime) modifiedTimes.set(token, meta.modifiedTime);
            }
          } catch (error) {
            logger.warn(`批量读取远端元数据失败，将逐文件校验内容：${String(error)}`);
          }
        }
        for (const note of remote.values()) {
          note.modifiedTime = modifiedTimes.get(note.entry.objToken);
        }

        const localHashCache = new Map<string, string>();
        const remoteHashCache = new Map<string, string>();

        plan = await buildPlan({
          state: settings.state,
          local,
          remote,
          isExcluded: (relPath) => filter.isExcluded(relPath),
          recreateRemoteIfDeleted: settings.recreateRemoteIfDeleted,
          propagateLocalDelete: settings.propagateLocalDelete,
          propagateRemoteDelete: settings.propagateRemoteDelete,
          hashLocal: async (relPath) => {
            const cached = localHashCache.get(relPath);
            if (cached) return cached;
            const hash = await sha256Hex(await readLocalBytes(this.deps.app, relPath));
            localHashCache.set(relPath, hash);
            return hash;
          },
          hashRemote: async (fileToken) => {
            const cached = remoteHashCache.get(fileToken);
            if (cached) return cached;
            const hash = await sha256Hex(await downloadFile(client, fileToken));
            remoteHashCache.set(fileToken, hash);
            return hash;
          },
        });
        plan = filterPlan(plan, options.mode);
      }

      plan = deferDeletes(plan, options.allowDeletes);
      plan.settingsFingerprint = planFingerprint(settings);
      if (options.dryRun) {
        return { plan, report: [], executed: false };
      }

      let allowPush = options.mode !== "pull";
      const allowPull = options.mode !== "push";
      let planForRun = plan;
      if (options.confirm) {
        const decision = await options.confirm(plan);
        if (decision === "cancel") return { plan, report: [], executed: false };
        if (decision === "pull-only") {
          allowPush = false;
          planForRun = filterPlan(plan, "pull");
        } else if (typeof decision === "object") {
          planForRun = applyPlanOverrides(plan, decision.actions);
        }
      }

      assertPlanCurrent(plan, settings);
      try {
        const report = await executePlan(
          planForRun,
          {
            app: this.deps.app,
            client,
            settings,
            state: settings.state,
            logger,
            spaceId,
            rootNodeToken,
          },
          {
            allowPush,
            allowPull,
            isEditorDirty: (relPath) => isEditorDirty(this.deps.app, relPath),
            onProgress: (message, done, total) => options.onProgress?.(`${message}（${done}/${total}）`),
          },
        );
        return { plan: planForRun, report, executed: true };
      } finally {
        // 中途失败也要落盘已完成的部分，否则下次会按旧基线重新判断
        await this.deps.saveSettings();
      }
    } catch (error) {
      await this.deps.saveSettings();
      throw error;
    }
  }
}
