import { assertPlanCurrent, deferDeletes, filterPlan, isEditorDirty, planFingerprint, prepareTarget, validateSettings, validateLocalPaths } from "./guards";
import type { App } from "obsidian";
import type { AuthManager } from "../feishu/auth";
import { FeishuClient } from "../feishu/client";
import { batchQueryMetas, downloadFile } from "../feishu/files";
import type { WikiSpace } from "../feishu/wiki";
import { listNodes, listSpaces, walkWikiTree } from "../feishu/wiki";
import type { Logger } from "../log";
import type { ReportEntry } from "./executor";
import { executePlan } from "./executor";
import { sha256Hex } from "./hash";
import { buildPlan } from "./planner";
import { PathFilter, assertSafeVaultPath, readLocalBytes, scanLocalNotes } from "./scanner";
import type { LocalNote, PluginSettings, RemoteNote, SyncPlan } from "./types";
import { joinPath } from "./types";

export type SyncMode = "both" | "pull" | "push";
export type PlanDecision = "all" | "pull-only" | "cancel";

export interface EngineDeps {
  app: App;
  getSettings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  auth: AuthManager;
  logger: Logger;
}

export interface RunOptions {
  mode: SyncMode;
  dryRun?: boolean;
  /** 定时同步只提示删除，手动预览确认后才执行。 */
  allowDeletes?: boolean;
  preApprovedPlan?: SyncPlan;
  /** 强制重推：忽略本地/远端基线，把本地有内容的笔记再发一遍（改了上行规则后刷新历史文档用） */
  forcePush?: boolean;
  onProgress?: (message: string) => void;
  confirm?: (plan: SyncPlan) => Promise<PlanDecision>;
}

export interface RunResult {
  plan: SyncPlan;
  report: ReportEntry[];
  executed: boolean;
}

export function parseTokenFromInput(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : value;
  } catch {
    return value;
  }
}

export class SyncEngine {
  private syncing = false;

  constructor(private readonly deps: EngineDeps) {}

  isSyncing(): boolean {
    return this.syncing;
  }

  createClient(): FeishuClient {
    return new FeishuClient((force) => this.deps.auth.getToken(force), this.deps.logger);
  }

  async listSpaces(): Promise<WikiSpace[]> {
    const client = this.createClient();
    return listSpaces(client);
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
    validateSettings(settings);
    const spaceId = parseTokenFromInput(settings.spaceId);
    // 留空表示以知识空间顶层为同步根：vault 的一级目录会成为知识库的一级页面
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
        // 状态丢失（清空状态、换机器、新装插件指向同一个知识库）时，先按标题认出已有的根目录页面。
        // 认不出来的话，它会被当成普通容器，根目录下的笔记读出来的路径会多一层前缀，
        // 于是一边新建一边新建，知识库与本地各多一份重复内容。
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
            throw new Error(`读取知识库顶层页面失败，已停止同步以避免重复创建：${String(error)}`);
          }
        }

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
          // macOS / Windows 的大小写不敏感与 NFC/NFD 差异会让两个不同标题落到同一个物理文件上
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
            const bytes = await readLocalBytes(this.deps.app, relPath);
            const hash = await sha256Hex(bytes);
            localHashCache.set(relPath, hash);
            return hash;
          },
          hashRemote: async (fileToken) => {
            const cached = remoteHashCache.get(fileToken);
            if (cached) return cached;
            const bytes = await downloadFile(client, fileToken);
            const hash = await sha256Hex(bytes);
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
