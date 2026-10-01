import { Notice, Plugin } from "obsidian";
import { randomBytes } from "crypto";
import { AuthManager, openExternal } from "./feishu/auth";
import { describeError, Logger } from "./log";
import type { SettingsHost, SyncEngineHandle } from "./settings-tab";
import { FeishuWikiSyncSettingTab } from "./settings-tab";
import type { PlanDecision, SyncMode } from "./sync/engine";
import { SyncEngine } from "./sync/engine";
import { DocSyncEngine } from "./sync/docEngine";
import type { PluginSettings, SyncAction, SyncState } from "./sync/types";
import { DEFAULT_SETTINGS } from "./sync/types";
import { AuthCodeModal } from "./ui/auth-modal";
import { PlanModal } from "./ui/plan-modal";
import { ReportModal } from "./ui/report-modal";

const CHANGE_ACTIONS = new Set<SyncAction>(["push", "create-remote", "pull", "create-local", "link", "delete-remote", "delete-local"]);

function setNoticeMessage(notice: Notice, message: string): void {
  const candidate = notice as Notice & { setMessage?: (value: string) => void };
  if (typeof candidate.setMessage === "function") candidate.setMessage(message);
}

export default class FeishuWikiSyncPlugin extends Plugin implements SettingsHost {
  settings: PluginSettings = DEFAULT_SETTINGS;
  logger!: Logger;
  auth!: AuthManager;
  mdEngine!: SyncEngine;
  docEngine!: DocSyncEngine;

  private statusBar: HTMLElement | null = null;
  private autoSyncHandle: number | null = null;
  private syncInFlight = false;

  /** 按设置里的同步模式选引擎，4 条命令与侧栏按钮都走这里。 */
  get engine(): SyncEngineHandle {
    return this.settings.syncMode === "doc" ? this.docEngine : this.mdEngine;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = new Logger(
      () => this.app,
      () => this.settings.debugLog,
    );
    this.auth = new AuthManager(
      () => ({
        mode: this.settings.authMode,
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        oauthScope: this.settings.oauthScope,
        redirectUri: this.settings.redirectUri,
      }),
      () => this.settings.userTokens,
      async (tokens) => {
        this.settings.userTokens = tokens;
        await this.saveSettings();
      },
      this.logger,
    );
    this.mdEngine = new SyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger,
    });
    this.docEngine = new DocSyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger,
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.registerDomEvent(this.statusBar, "click", () => void this.runSync("both"));
    this.updateStatusBar();

    this.addSettingTab(new FeishuWikiSyncSettingTab(this.app, this));

    this.addCommand({ id: "preview-plan", name: "预览同步计划", callback: () => void this.runSync("both", { preview: true }) });
    this.addCommand({ id: "sync-both", name: "双向同步", callback: () => void this.runSync("both") });
    this.addCommand({ id: "sync-pull", name: "从飞书拉取到本地", callback: () => void this.runSync("pull") });
    this.addCommand({ id: "sync-push", name: "把本地推送到飞书", callback: () => void this.runSync("push") });
    this.addCommand({
      id: "force-push",
      name: "强制重推（忽略基线，刷新所有本地笔记）",
      callback: () => void this.runSync("push", { forcePush: true }),
    });

    this.addRibbonIcon("refresh-cw", "Feishu Wiki Sync：双向同步", () => void this.runSync("both"));

    this.refreshAutoSync();
  }

  onunload(): void {
    if (this.autoSyncHandle !== null) window.clearInterval(this.autoSyncHandle);
    this.autoSyncHandle = null;
    this.statusBar = null;
    this.auth?.cancelAuthorization();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as (Partial<PluginSettings> & { state?: Partial<SyncState> }) | null;
    const state: Partial<SyncState> = raw?.state ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(raw ?? {}),
      state: {
        records: state.records ?? {},
        folders: state.folders ?? {},
        conflicts: state.conflicts ?? {},
        docRecords: state.docRecords ?? {},
        images: state.images ?? {},
        imageUploads: state.imageUploads ?? {},
        target: state.target,
        lastSyncAt: state.lastSyncAt,
      },
    };
  }

  isSyncBusy(): boolean {
    return this.syncInFlight || this.mdEngine?.isSyncing() || this.docEngine?.isSyncing();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (!minutes || minutes <= 0) return;
    this.autoSyncHandle = this.registerInterval(window.setInterval(() => {
      if (this.isSyncBusy()) return;
      if (this.settings.authMode === "user" && !this.auth.hasValidUserGrant()) return;
      void this.runSync("both", { quiet: true });
    }, minutes * 60_000));
  }

  async startAuthorization(): Promise<void> {
    const state = randomBytes(24).toString("hex");
    const server = this.auth.startCallbackServer(state);
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    new Notice("已打开浏览器，请在飞书里完成授权");
    try {
      const code = await server.waitForCode();
      await this.auth.exchangeCode(code);
      new Notice("飞书授权成功");
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async startManualAuthorization(): Promise<void> {
    const state = randomBytes(24).toString("hex");
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    await new Promise<void>((resolve) => {
      new AuthCodeModal(
        this.app,
        authorizeUrl,
        async (codeOrUrl) => {
          try {
            await this.auth.exchangeCode(codeOrUrl);
            new Notice("飞书授权成功");
          } catch (error) {
            new Notice(`授权失败：${describeError(error)}`, 10000);
          }
          resolve();
        },
        () => resolve(),
      ).open();
    });
  }

  async revokeAuthorization(): Promise<void> {
    this.settings.userTokens = undefined;
    await this.saveSettings();
    new Notice("已清除本地保存的飞书授权");
  }

  async runSync(
    mode: SyncMode,
    options: { preview?: boolean; quiet?: boolean; forcePush?: boolean } = {},
  ): Promise<void> {
    if (this.engine.isSyncing() || this.syncInFlight) {
      new Notice("飞书同步：已有任务在执行中");
      return;
    }
    if (!this.settings.appId || !this.settings.appSecret) {
      new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
      return;
    }
    if (options.forcePush && this.settings.syncMode !== "doc") {
      new Notice("强制重推仅用于文档模式；文件镜像模式请使用普通同步");
      return;
    }

    this.syncInFlight = true;
    const engine = this.engine;
    const label = this.settings.syncMode === "doc" ? "飞书文档同步" : "飞书文件同步";
    const wantPreview = !options.quiet && (this.settings.propagateLocalDelete || this.settings.propagateRemoteDelete ||
      options.forcePush === true || (options.preview ?? this.settings.showPlanBeforeSync));
    const forcePush = options.forcePush === true;
    const notice = new Notice(`${label}：准备中…`, 0);
    let running: Notice | undefined;
    const progress = (message: string) => setNoticeMessage(notice, `${label}：${message}`);

    try {
      if (wantPreview) {
        const preview = await engine.run({ mode, dryRun: true, forcePush, onProgress: progress });
        notice.hide();
        const decision = await new Promise<PlanDecision>((resolve) => new PlanModal(this.app, preview.plan, resolve).open());
        if (decision === "cancel") return;
        running = new Notice(`${label}：执行中…`, 0);
        // 执行的就是用户刚刚确认的那份计划；写盘前执行器还会复核本地是否又有改动
        const result = await engine.run({
          mode,
          preApprovedPlan: preview.plan,
          onProgress: (message) => setNoticeMessage(running!, `${label}：${message}`),
          confirm: async () => decision,
        });
        running.hide();
        new ReportModal(this.app, result.plan, result.report, result.executed).open();
        return;
      }

      const result = await engine.run({ mode, forcePush, allowDeletes: !options.quiet, onProgress: progress, confirm: async () => "all" });
      notice.hide();
      const failures = result.report.filter((entry) => !entry.ok).length;
      const conflicts = result.report.filter((entry) => entry.action === "conflict").length;
      const changes = result.report.filter((entry) => entry.ok && CHANGE_ACTIONS.has(entry.action)).length;
      const pendingDeletes = result.report.some(entry => entry.action === "local-deleted" || entry.action === "remote-deleted");
      if (options.quiet && failures === 0 && conflicts === 0 && !pendingDeletes && !result.plan.warnings?.length) {
        if (changes > 0) new Notice(`${label}完成：${changes} 项变更`);
      } else {
        new ReportModal(this.app, result.plan, result.report, result.executed).open();
      }
    } catch (error) {
      notice.hide();
      this.logger.error(`同步失败：${describeError(error)}`);
      new Notice(`${label}失败：${describeError(error)}`, 12000);
    } finally {
      running?.hide();
      notice.hide();
      this.syncInFlight = false;
      await this.logger.flush();
      this.updateStatusBar();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const last = this.settings.state.lastSyncAt;
    const docMode = this.settings.syncMode === "doc";
    const count = Object.keys(docMode ? this.settings.state.docRecords : this.settings.state.records).length;
    const stamp = last ? new Date(last).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未同步";
    this.statusBar.setText(`飞书${docMode ? "文档" : ""} ${stamp} · ${count} 篇`);
    this.statusBar.setAttr("aria-label", docMode ? "点击执行文档模式双向同步" : "点击执行飞书双向同步");
  }
}
