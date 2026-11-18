import type { App } from "obsidian";
import type { AuthManager } from "../feishu/auth";
import { FeishuClient } from "../feishu/client";
import type { WikiSpace } from "../feishu/wiki";
import { listNodes, listSpaces } from "../feishu/wiki";
import type { Logger } from "../log";
import type { ReportEntry } from "./executor";
import type { PluginSettings, SyncPlan } from "./types";

export type SyncMode = "both" | "pull" | "push";

/** 预览弹窗里对单个文件选择的动作；未列出的文件按计划执行。 */
export type ItemChoice = "skip" | "pull" | "push";

export interface PlanOverrides {
  kind: "overrides";
  actions: Record<string, ItemChoice>;
}

export type PlanDecision = "all" | "pull-only" | "cancel" | PlanOverrides;

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
  /** 忽略基线，把本地有内容的笔记再发一遍（改了上行规则后刷新历史文档用）。 */
  forcePush?: boolean;
  onProgress?: (message: string) => void;
  confirm?: (plan: SyncPlan) => Promise<PlanDecision>;
}

export interface RunResult {
  plan: SyncPlan;
  report: ReportEntry[];
  executed: boolean;
}

/** 粘贴输入兼容 /wiki/ 链接：取 URL 最后一段。 */
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

/** 两种模式共用的骨架：同步锁、客户端、空间列表、根容器识别。 */
export abstract class BaseSyncEngine {
  private syncing = false;

  protected constructor(protected readonly deps: EngineDeps) {}

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

  protected abstract runInternal(options: RunOptions): Promise<RunResult>;

  /** 状态丢失时按标题认回知识库顶层已有页面，避免重复建根容器、重复同步。 */
  protected async recognizeRootContainer(client: FeishuClient, settings: PluginSettings, spaceId: string, rootNodeToken: string | undefined): Promise<void> {
    if (rootNodeToken || settings.state.folders[""]?.nodeToken) return;
    const title = settings.rootPageTitle.trim() || this.deps.app.vault.getName();
    try {
      const topLevel = await listNodes(client, spaceId);
      const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
      if (found?.node_token) {
        settings.state.folders[""] = { nodeToken: found.node_token };
        this.deps.logger.info(`识别到已有的知识库顶层页面「${title}」，复用它存放 vault 根目录下的笔记`);
      }
    } catch (error) {
      throw new Error(`读取知识库顶层页面失败，已停止同步以避免重复创建：${String(error)}`);
    }
  }
}
