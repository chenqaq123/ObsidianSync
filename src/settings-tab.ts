import type { App, Plugin } from "obsidian";
import { FileSystemAdapter, FuzzySuggestModal, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type { AuthManager } from "./feishu/auth";
import type { WikiSpace } from "./feishu/wiki";
import type { Logger } from "./log";
import { CONFLICT_DIR, emptyState } from "./sync/types";
import type { PluginSettings } from "./sync/types";
import type { RunOptions, RunResult } from "./sync/engine";
import { defaultRulesFile, loadRules, RULES_PATH, writeRulesFile } from "./convert/rules";

/** 两种模式的引擎（md 文件镜像 / 飞书文档）共用的入口。 */
export interface SyncEngineHandle {
  isSyncing(): boolean;
  listSpaces(): Promise<WikiSpace[]>;
  run(options: RunOptions): Promise<RunResult>;
}

export interface SettingsHost {
  app: App;
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  auth: AuthManager;
  engine: SyncEngineHandle;
  logger: Logger;
  startAuthorization(): Promise<void>;
  startManualAuthorization(): Promise<void>;
  revokeAuthorization(): Promise<void>;
  refreshAutoSync(): void;
  isSyncBusy(): boolean;
}

class SpacePickerModal extends FuzzySuggestModal<WikiSpace> {
  constructor(
    app: App,
    private readonly spaces: WikiSpace[],
    private readonly onChoose: (space: WikiSpace) => void,
  ) {
    super(app);
    this.setPlaceholder("选择要同步的知识空间");
  }

  getItems(): WikiSpace[] {
    return this.spaces;
  }

  getItemText(space: WikiSpace): string {
    return `${space.name} · ${space.space_id}`;
  }

  onChooseItem(space: WikiSpace): void {
    this.onChoose(space);
  }
}

export class FeishuWikiSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost & Plugin,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.host.settings;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "将当前仓库的 Markdown 笔记与飞书知识库双向同步。文档模式便于在飞书阅读与编辑；文件镜像模式保留原始 Markdown。",
    });

    this.renderAuth(containerEl, settings);
    this.renderTarget(containerEl, settings);
    this.renderSyncMode(containerEl, settings);
    this.renderRules(containerEl);
    this.renderBehaviour(containerEl, settings);
    this.renderState(containerEl, settings);
  }

  private renderSyncMode(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName("同步模式").setHeading();

    new Setting(containerEl)
      .setName("笔记同步形态")
      .setDesc(
        "文件镜像保留原始 Markdown；文档模式生成可编辑的飞书新版文档，支持图片、列表、代码、表格和公式。" +
          "文档模式会转换排版，不能保证源码逐字不变；切换模式会重新对接，同名但内容不同则保留双方并报告冲突。",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("md", "文件镜像（原生 Markdown）")
          .addOption("doc", "文档模式（飞书新版文档）")
          .setValue(settings.syncMode)
          .onChange(async (value) => {
            const next = value === "doc" ? "doc" : "md";
            if (next === settings.syncMode) return;
            settings.syncMode = next;
            await this.host.saveSettings();
            this.host.refreshAutoSync();
            new Notice(
              next === "doc"
                ? "已切到文档模式：下一次同步按「首次对接」判定，不会直接覆盖本地"
                : "已切到文件镜像模式：下一次同步按「首次对接」判定，不会直接覆盖本地",
            );
            this.display();
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `当前：${settings.syncMode === "doc" ? "文档模式（飞书新版文档 docx）" : "文件镜像（原生 Markdown 文件）"} · 文档模式的转换规则在 ${RULES_PATH}`,
    });
  }

  private renderRules(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("转换规则（文档模式）").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `规则文件：${RULES_PATH}，每条规则都有 enabled 开关与 description 说明。上行规则在发给飞书之前作用于本地 Markdown，` +
        "下行规则在写回本地之前作用于取回的 Markdown。文件不存在时会自动写入一份完整默认规则；加载时与内置默认按 id 合并，改过的以文件为准。上行规则更新后，旧文档会进入刷新计划；飞书有新改动时优先处理改动。原稿格式提示默认关闭，可通过 source-format-diagnostics 开启。",
    });

    new Setting(containerEl)
      .setName("打开规则文件")
      .setDesc("用系统默认程序打开 rules.json，改完保存，下次同步生效")
      .addButton((button) =>
        button.setButtonText("打开").onClick(async () => {
          const adapter = this.host.app.vault.adapter;
          const path = normalizePath(RULES_PATH);
          try {
            if (!(await adapter.exists(path))) await writeRulesFile(adapter, defaultRulesFile());
            if (adapter instanceof FileSystemAdapter) {
              const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };
              const error = await shell.openPath(adapter.getFullPath(path));
              if (error) throw new Error(error);
            } else {
              new Notice(`请在文件系统里打开 ${path}`);
            }
          } catch (error) {
            new Notice(`打开规则文件失败：${String(error)}。文件位置：${path}`, 8000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("重建为默认规则")
      .setDesc("用内置默认规则覆盖 rules.json（会丢掉你在文件里的改动），并做一次解析检查")
      .addButton((button) =>
        button.setButtonText("重建").onClick(async () => {
          try {
            const adapter = this.host.app.vault.adapter;
            await writeRulesFile(adapter, defaultRulesFile());
            const rules = await loadRules(adapter, this.host.logger);
            const enabled = (list: { enabled: boolean }[]) => list.filter((entry) => entry.enabled).length;
            new Notice(
              `已重建 ${RULES_PATH}：上行 ${enabled(rules.toFeishu)} 条、下行 ${enabled(rules.toObsidian)} 条规则开启`,
              8000,
            );
            this.display();
          } catch (error) {
            new Notice(`重建规则文件失败：${String(error)}`, 8000);
          }
        }),
      );
  }

  private renderAuth(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName("飞书应用与授权").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "需要一个飞书企业自建应用。默认授权范围：drive:drive、wiki:wiki、docx:document、docs:document.media:download、docs:document.media:upload；详见 README 的配置步骤。用「用户授权」时还要在开放平台登记下方重定向地址，并包含 offline_access 以自动续期。",
    });

    new Setting(containerEl)
      .setName("身份模式")
      .setDesc("用户授权：以你本人的身份访问个人知识库（推荐）。应用身份：需要把应用添加为知识库成员。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("user", "用户授权（user_access_token）")
          .addOption("tenant", "应用身份（tenant_access_token）")
          .setValue(settings.authMode)
          .onChange(async (value) => {
            settings.authMode = value as PluginSettings["authMode"];
            await this.host.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("App ID")
      .setDesc("飞书开放平台 → 凭证与基础信息")
      .addText((text) =>
        text.setValue(settings.appId).onChange(async (value) => {
          if (settings.appId !== value.trim()) settings.userTokens = undefined;
          settings.appId = value.trim();
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("App Secret")
      .setDesc("保存在插件的 data.json 里，请勿把该文件同步到公开仓库")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(settings.appSecret).onChange(async (value) => {
          if (settings.appSecret !== value.trim()) settings.userTokens = undefined;
          settings.appSecret = value.trim();
          await this.host.saveSettings();
        });
      });

    if (settings.authMode === "user") {
      new Setting(containerEl)
        .setName("重定向地址")
        .setDesc("需要与开放平台里登记的回调地址完全一致")
        .addText((text) =>
          text.setValue(settings.redirectUri).onChange(async (value) => {
            settings.redirectUri = value.trim();
            await this.host.saveSettings();
          }),
        );

      new Setting(containerEl)
        .setName("授权范围")
        .setDesc("空格分隔，必须都是应用已开通的权限；offline_access 用于自动续期")
        .addText((text) =>
          text.setValue(settings.oauthScope).onChange(async (value) => {
            settings.oauthScope = value.trim();
            await this.host.saveSettings();
          }),
        );

      const tokens = settings.userTokens;
      new Setting(containerEl)
        .setName("授权状态")
        .setDesc(
          tokens?.refreshToken
            ? `已授权，refresh token 有效至 ${new Date(tokens.refreshExpiresAt).toLocaleString()}`
            : "尚未授权",
        )
        .addButton((button) =>
          button
            .setButtonText(tokens?.refreshToken ? "重新授权" : "授权飞书账号")
            .setCta()
            .onClick(async () => {
              try {
                await this.host.startAuthorization();
                this.display();
              } catch (error) {
                new Notice(`授权失败：${error instanceof Error ? error.message : String(error)}`);
              }
            }),
        )
        .addButton((button) =>
          button.setButtonText("手动粘贴授权码").onClick(async () => {
            try {
              await this.host.startManualAuthorization();
              this.display();
            } catch (error) {
              new Notice(`授权失败：${error instanceof Error ? error.message : String(error)}`);
            }
          }),
        )
        .addButton((button) =>
          button.setButtonText("撤销授权").onClick(async () => {
            await this.host.revokeAuthorization();
            this.display();
          }),
        );
    }

    new Setting(containerEl)
      .setName("连接测试")
      .setDesc("拉取当前身份可见的知识空间列表")
      .addButton((button) =>
        button.setButtonText("测试").onClick(async () => {
          try {
            const spaces = await this.host.engine.listSpaces();
            new Notice(spaces.length > 0 ? `连接成功，可见知识空间 ${spaces.length} 个` : "连接成功，但没有可见的知识空间");
          } catch (error) {
            new Notice(`连接失败：${error instanceof Error ? error.message : String(error)}`, 8000);
          }
        }),
      );
  }

  private renderTarget(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName("同步目标").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "本地 vault 根目录 ↔ 知识空间。只有 .md 文件参与同步；同步会在知识库里按本地目录层级创建页面。",
    });

    new Setting(containerEl)
      .setName("知识空间 space_id")
      .setDesc("建议用「拉取列表」选择；手填时使用数字 space_id，不要粘贴 /wiki/ 页面链接")
      .addText((text) =>
        text.setValue(settings.spaceId).onChange(async (value) => {
          settings.spaceId = value.trim();
          await this.host.saveSettings();
        }),
      )
      .addButton((button) =>
        button.setButtonText("拉取列表").onClick(async () => {
          try {
            const spaces = await this.host.engine.listSpaces();
            if (spaces.length === 0) {
              new Notice("当前身份看不到任何知识空间");
              return;
            }
            new SpacePickerModal(this.app, spaces, async (space) => {
              settings.spaceId = space.space_id;
              await this.host.saveSettings();
              new Notice(`已选择知识空间：${space.name}`);
              this.display();
            }).open();
          } catch (error) {
            new Notice(`拉取失败：${error instanceof Error ? error.message : String(error)}`, 8000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("同步根节点（可留空）")
      .setDesc(
        "留空 = 以知识空间顶层为同步根：vault 的一级目录会变成知识库里的一级页面（vault 根目录下的散装笔记会放进下方那个顶层页面里）。填节点链接或 node_token 则所有内容都挂到该节点下面，飞书侧不会多出一个根页面。注意：留空时，知识库顶层已有的 .md 文件会被拉取到你的 vault 根目录。",
      )
      .addText((text) =>
        text.setValue(settings.rootNodeToken).onChange(async (value) => {
          settings.rootNodeToken = value.trim();
          await this.host.saveSettings();
          this.display();
        }),
      );

    if (!settings.rootNodeToken.trim()) {
      new Setting(containerEl)
        .setName("根目录页面标题")
        .setDesc("存放 vault 根目录下笔记的那个知识库一级页面的名称，留空则用 vault 的名字（当前：" + this.app.vault.getName() + "）")
        .addText((text) =>
          text.setValue(settings.rootPageTitle).onChange(async (value) => {
            settings.rootPageTitle = value.trim();
            await this.host.saveSettings();
          }),
        );
    }
  }

  private renderBehaviour(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName("同步行为").setHeading();

    new Setting(containerEl)
      .setName("附件目录")
      .setDesc("文档模式下行时，从飞书下载的图片放到这个目录（相对 vault 根，填 attachments 这类相对路径；目录不存在会自动创建）。")
      .addText((text) =>
        text.setValue(settings.attachmentFolder).onChange(async (value) => {
          settings.attachmentFolder = value.trim() || "attachments";
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("附件链接写法")
      .setDesc("从飞书下载图片后，笔记里引用写成哪种形式。最短路径 = 只写文件名（如 ![[image-xxx.png]]，与 Obsidian「最短路径」链接格式一致）；带目录 = 写 ![[附件目录/文件名]]。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("shortest", "只写文件名（最短路径）")
          .addOption("path", "带附件目录前缀")
          .setValue(settings.attachmentLinkStyle)
          .onChange(async (value) => {
            settings.attachmentLinkStyle = value as "shortest" | "path";
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("目录层级")
      .setDesc("镜像目录：为每个本地文件夹建一个知识库节点（会多出一些空文档页）。扁平：所有笔记挂在根节点下，文件名用分隔符编码路径。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("nodes", "镜像目录（推荐）")
          .addOption("flat", "扁平化")
          .setValue(settings.folderMode)
          .onChange(async (value) => {
            settings.folderMode = value as PluginSettings["folderMode"];
            await this.host.saveSettings();
            this.display();
          }),
      );

    if (settings.folderMode === "flat") {
      new Setting(containerEl)
        .setName("扁平分隔符")
        .setDesc("用该字符串替换路径里的 /")
        .addText((text) =>
          text.setValue(settings.flatSeparator).onChange(async (value) => {
            settings.flatSeparator = value || "__";
            await this.host.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("排除规则")
      .setDesc("每行一条 glob，支持 * 与 **。.obsidian/ 与 .trash/ 始终排除，冲突副本目录也始终排除。")
      .addTextArea((area) => {
        area.setValue(settings.excludePatterns).onChange(async (value) => {
          settings.excludePatterns = value;
          await this.host.saveSettings();
        });
        area.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("远端已删除时自动重建")
      .setDesc("关闭时（推荐）只会提示，不会把本地有修改的笔记重新传上去")
      .addToggle((toggle) =>
        toggle.setValue(settings.recreateRemoteIfDeleted).onChange(async (value) => {
          settings.recreateRemoteIfDeleted = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("文档模式：每轮取回全文校验")
      .setDesc(
        "关闭（默认）：先用飞书返回的「最后修改时间」（秒级）判断远端有没有变，没变就不取回全文，一轮只多一次批量元数据请求。" +
          "代价是理论上存在极端情况——同一秒内的远端改动可能被漏判到下一次时间戳变化。" +
          "打开：忽略时间戳，每轮对每篇已记录文档都取回全文逐篇校验，最稳，但请求数与流量明显更高。",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.docVerifyRemoteByContent).onChange(async (value) => {
          settings.docVerifyRemoteByContent = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl).setName("删除传播（默认关闭）").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "两个开关都关着时，任何一边删除都只在同步结果里提示，不会自动删另一边。打开后删除会出现在计划预览的独立分组里，" +
        "需要你在预览框里确认才会执行。",
    });

    new Setting(containerEl)
      .setName("本地删除后同时删除远端")
      .setDesc(
        "本地删掉的笔记，同步时把远端对应的文件/文档一起删掉（走云空间接口，删除进飞书回收站，可以恢复）。" +
          "远端自上次同步后被改过、或该路径命中排除规则时，都不会删，仍然按冲突/忽略处理。" +
          "删除始终需要手动同步确认；定时同步只提示待删除项。",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.propagateLocalDelete).onChange(async (value) => {
          settings.propagateLocalDelete = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("远端删除后同时删除本地")
      .setDesc(
        "远端删掉的文件/文档，同步时把本地笔记移进 vault 的 .trash（不是永久删除），并清掉映射关系。" +
          "本地自上次同步后被改过时不会删，只会提示。" +
          "注意：这条会真的动你本地的文件，同样会在计划预览里单独列出等你确认。",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.propagateRemoteDelete).onChange(async (value) => {
          settings.propagateRemoteDelete = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("同步前预览计划")
      .setDesc("每次同步先弹出计划确认框")
      .addToggle((toggle) =>
        toggle.setValue(settings.showPlanBeforeSync).onChange(async (value) => {
          settings.showPlanBeforeSync = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("定时自动同步")
      .setDesc("单位分钟，0 表示关闭。自动同步跳过预览、保留冲突副本；删除项留待手动同步确认。")
      .addText((text) =>
        text.setValue(String(settings.autoSyncMinutes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.autoSyncMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.host.saveSettings();
          this.host.refreshAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("调试日志")
      .setDesc(`写入 .obsidian/feishu-sync/sync.log`)
      .addToggle((toggle) =>
        toggle.setValue(settings.debugLog).onChange(async (value) => {
          settings.debugLog = value;
          await this.host.saveSettings();
        }),
      );
  }

  private renderState(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName("状态").setHeading();
    const records = Object.keys(settings.syncMode === "doc" ? settings.state.docRecords : settings.state.records).length;
    const folders = Object.keys(settings.state.folders).length;

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `上次同步：${settings.state.lastSyncAt ? new Date(settings.state.lastSyncAt).toLocaleString() : "从未同步"} · 已映射笔记 ${records} 篇 · 已建目录节点 ${folders} 个`,
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `冲突副本目录：${CONFLICT_DIR}/（本地与远端都不改动，副本仅作参考）`,
    });

    new Setting(containerEl)
      .setName("清空同步状态")
      .setDesc("清掉两种模式的映射、图片缓存与同步时间，保留账号、规则和笔记。下次按首次对接判定；同名但内容不同会报告冲突。")
      .addButton((button) =>
        button.setWarning().setButtonText("清空").onClick(async () => {
          if (this.host.isSyncBusy()) {
            new Notice("同步正在进行中，请等它结束后再清空状态");
            return;
          }
          settings.state = emptyState();
          await this.host.saveSettings();
          new Notice("同步状态已清空");
          this.display();
        }),
      );

    new Setting(containerEl).setName("已知边界").setHeading();
    const list = containerEl.createEl("ul", { cls: "setting-item-description" });
    list.createEl("li", { text: "飞书不接受 0 字节 Markdown，空文件在文件镜像模式下会被跳过并提示；文档模式下空笔记也会同步（正文为空，飞书侧只有标题）。" });
    list.createEl("li", { text: "文档模式会上传本地图片（写进文档的图片块）并下载飞书里的图片到附件目录；规则文件里 image-upload / image-download 可关。文件镜像模式不做图片处理，图片只是笔记里的文本。" });
    list.createEl("li", { text: "删除默认不会传播，只在结果里提示；要传播就在上面打开对应的删除开关（远端删除进飞书回收站，本地删除进 .trash）。" });
    list.createEl("li", { text: "两边同时修改同一篇时按冲突处理：远端版本另存为副本，本地与远端都不动。" });
  }
}
