import type { App } from "obsidian";
import { FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";
import type { AuthManager } from "../feishu/auth";
import { FeishuClient } from "../feishu/client";
import { buildMarkdownContent, createDocumentFromMarkdown, fetchDocumentMarkdown, updateDocumentFromMarkdown } from "../feishu/docs";
import { createContainerNode, getNodeByToken, moveDocToWiki } from "../feishu/wiki";
import type { Logger } from "../log";
import { describeError } from "../log";
import { ROUNDTRIP_REPORT_PATH, appendSyntaxSample, formatTimestamp, renderRoundtripReport } from "../roundtrip";
import { parseTokenFromInput } from "../sync/engine";
import type { PluginSettings } from "../sync/types";

export interface RoundtripHost {
  app: App;
  getSettings: () => PluginSettings;
  auth: AuthManager;
  logger: Logger;
}

class NotePickerModal extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly resolve: (file: TFile | undefined) => void,
  ) {
    super(app);
    this.setPlaceholder("没有打开的笔记，选择一篇用来做往返测试");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.pick(file);
  }

  onClose(): void {
    this.pick(undefined);
  }

  private pick(file: TFile | undefined): void {
    if (this.chosen) return;
    this.chosen = true;
    this.resolve(file);
  }
}

function setNoticeMessage(notice: Notice, message: string): void {
  const candidate = notice as Notice & { setMessage?: (value: string) => void };
  if (typeof candidate.setMessage === "function") candidate.setMessage(message);
}

function pickNote(app: App): Promise<TFile | undefined> {
  const active = app.workspace.getActiveFile();
  if (active) return Promise.resolve(active);
  const files = app.vault.getMarkdownFiles();
  if (files.length === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => new NotePickerModal(app, files, resolve).open());
}

/** 报告是运行时产物，写进 vault 根目录；用 vault API 写，Obsidian 会立刻认得这个文件。 */
async function writeReport(app: App, content: string): Promise<void> {
  const path = normalizePath(ROUNDTRIP_REPORT_PATH);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  await app.vault.create(path, content);
}

/**
 * 「测试：Markdown 往返转换」：只读本地笔记，把内容（+固定语法样本）写成飞书文档、取回、
 * 再更新一次取回，最后把四段内容与差异写成报告。不改动同步逻辑与同步状态。
 */
export async function runRoundtripProbe(host: RoundtripHost): Promise<void> {
  const settings = host.getSettings();
  if (!settings.appId || !settings.appSecret) {
    new Notice("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
    return;
  }
  const spaceId = parseTokenFromInput(settings.spaceId);
  if (!spaceId) {
    new Notice("请先在插件设置里选择知识空间（space_id）");
    return;
  }

  const file = await pickNote(host.app);
  if (!file) {
    new Notice("往返测试已取消：没有可用作样本的笔记");
    return;
  }

  const noteText = await host.app.vault.read(file);
  const localContent = appendSyntaxSample(noteText);
  const startedAt = new Date();
  const stamp = formatTimestamp(startedAt);
  const documentTitle = `同步往返测试 ${stamp}`;
  const containerTitle = `同步往返测试 ${stamp}（容器页面）`;

  const client = new FeishuClient((force) => host.auth.getToken(force), host.logger);
  const notice = new Notice("Markdown 往返测试：准备中…", 0);
  const progress = (message: string): void => {
    host.logger.info(`往返测试：${message}`);
    setNoticeMessage(notice, `Markdown 往返测试：${message}`);
  };
  host.logger.info(`往返测试开始：样本 ${file.path}（${localContent.length} 字符），空间 ${spaceId}`);

  try {
    progress(`创建知识空间顶层页面「${containerTitle}」…`);
    const container = await createContainerNode(client, spaceId, undefined, containerTitle);

    const created = await createDocumentFromMarkdown(client, {
      title: documentTitle,
      markdown: localContent,
      onProgress: progress,
    });
    host.logger.info(`往返测试：文档 document_id=${created.documentId}${created.url ? ` url=${created.url}` : ""}`);

    progress("把文档移到测试页面下…");
    await moveDocToWiki(client, spaceId, container.node_token, created.documentId, "docx");

    let wikiNodeToken: string | undefined;
    try {
      const node = await getNodeByToken(client, created.documentId, "docx");
      wikiNodeToken = node?.node_token;
    } catch (error) {
      // 移动可能返回异步任务（applied 需审批），查不到节点不影响后面的取回
      host.logger.warn(`往返测试：移动后查询知识库节点失败，报告里只写标题：${describeError(error)}`);
    }

    progress("第一次取回（fetch）…");
    const firstFetch = await fetchDocumentMarkdown(client, created.documentId);

    progress("用同一份内容再更新一次（overwrite）…");
    await updateDocumentFromMarkdown(client, created.documentId, { title: documentTitle, markdown: localContent });

    progress("第二次取回（fetch）…");
    const secondFetch = await fetchDocumentMarkdown(client, created.documentId);

    const report = await renderRoundtripReport({
      notePath: file.path,
      noteText,
      documentTitle,
      spaceId,
      containerTitle,
      containerNodeToken: container.node_token,
      documentId: created.documentId,
      documentUrl: created.url,
      wikiNodeToken,
      localContent,
      sentContent: buildMarkdownContent(documentTitle, localContent),
      firstFetch,
      secondFetch,
      startedAt,
      finishedAt: new Date(),
      apiLog: buildApiLog({ spaceId, documentId: created.documentId, containerNodeToken: container.node_token }),
    });

    await writeReport(host.app, report);
    notice.hide();
    host.logger.info(`往返测试完成：报告 ${ROUNDTRIP_REPORT_PATH}`);
    new Notice(`往返测试报告已写入 ${ROUNDTRIP_REPORT_PATH}`, 12000);
  } catch (error) {
    notice.hide();
    host.logger.error(`往返测试失败：${describeError(error)}`);
    new Notice(`往返测试失败：${describeError(error)}`, 12000);
  } finally {
    await host.logger.flush();
  }
}

function buildApiLog(input: { spaceId: string; documentId: string; containerNodeToken: string }): string[] {
  return [
    "`POST /open-apis/docs_ai/v1/documents`：body `format=\"markdown\"`、`content`=②（标题用 DocxXML 的 `<title>` 放在最前面）、`extra_param=\"{\\\"open_create_async\\\":true}\"`（是否走异步由服务端决定）",
    "（返回 `task_id` 时）`GET /open-apis/docs_ai/v1/async_tasks/{task_id}`：轮询到 status=succeeded，从 `result.create_document` 里取 `document.document_id`",
    `\`POST /open-apis/wiki/v2/spaces/${input.spaceId}/nodes\`：在空间顶层建容器页面（\`obj_type=docx\`、\`node_type=origin\`、不带 \`parent_node_token\`）`,
    `\`POST /open-apis/wiki/v2/spaces/${input.spaceId}/nodes/move_docs_to_wiki\`：body \`obj_type=docx\`、\`obj_token=${input.documentId}\`、\`parent_wiki_token=${input.containerNodeToken}\`、\`apply=true\``,
    `\`GET /open-apis/wiki/v2/spaces/node_by_token\`：query \`token=${input.documentId}\`、\`obj_type=docx\`（用来确认移动结果）`,
    `\`POST /open-apis/docs_ai/v1/documents/${input.documentId}/fetch\`：body \`format=\"markdown\"\`、\`extra_param\`=CLI 的默认值、\`export_option\` 三项全 false`,
    `\`PUT /open-apis/docs_ai/v1/documents/${input.documentId}\`：body \`format=\"markdown\"\`、\`command=\"overwrite\"\`、\`revision_id=-1\`、\`content\`=②`,
    `\`POST /open-apis/docs_ai/v1/documents/${input.documentId}/fetch\`：同第一次`,
  ];
}
