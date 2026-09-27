/**
 * 离线端到端测试：本地 vault ↔ 假飞书 Wiki。
 *
 * 除 `requestUrl` 被替换成下面的假服务器外，planner / executor / engine / scanner / state
 * 全部是 src/ 里的真代码，vault 也是真实文件系统（/tmp/feishu-e2e/vault）。
 *
 * 运行：npm run test:e2e
 */
import fs from "node:fs";
import path from "node:path";

import { __setRequestUrlHandler, TFile } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

import { buildMarkdownContent } from "../src/feishu/docs";
import { setRequestBudgetForTest } from "../src/feishu/client";
import { applyRules, defaultRulesFile, normalizeRemoteImageUrls, RULES_PATH } from "../src/convert/rules";
import type { RuleContext } from "../src/convert/rules";
import { ROUNDTRIP_REPORT_PATH, SYNTAX_CHECKS, SYNTAX_SAMPLE, appendSyntaxSample } from "../src/roundtrip";
import { DocSyncEngine } from "../src/sync/docEngine";
import { SyncEngine } from "../src/sync/engine";
import type { RunOptions, RunResult, SyncMode } from "../src/sync/engine";
import type { ReportEntry } from "../src/sync/executor";
import { sha256Hex } from "../src/sync/hash";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/types";
import type { PluginSettings, SyncPlan } from "../src/sync/types";
import { runRoundtripProbe } from "../src/ui/roundtrip-command";

// ---------------------------------------------------------------- 常量 / 工具

const SRC_VAULT = "/Users/cgx/Desktop/WorkHard/Work";
const TMP_ROOT = "/tmp/feishu-e2e";
const VAULT_ROOT = path.join(TMP_ROOT, "vault");
const CONFLICT_DIR_REL = ".obsidian/feishu-sync/conflicts";

const SPACE_ID = "spc_test";
const ROOT_NODE = "wikcn_root";
/** 假 vault 的名字，用于断言"根页面标题默认取 vault 名"。 */
const VAULT_NAME = "Work";

const PUSH_TARGET = "Meetings&Talks/2026.05.25 潘博分享.md";
const PULL_TARGET = "Research&Learning/2026.08 具身智能.md";
const CONFLICT_TARGET = "MyPapers/T2V Benchmark/01-FilmBench/01-ICLR 2027.md";
const EMPTY_DOWNLOAD_TARGET = "FudanLab/info/实验室nas.md";

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} 不匹配：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer as ArrayBuffer;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value !== 0);
  if (entries.length === 0) return "（空）";
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function headerOf(options: RequestUrlParam, name: string): string {
  const headers = options.headers ?? {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

/** docs_ai 的 content 把标题放在最前面的 <title> 标签里。 */
function docTitleOf(content: string): string {
  const match = /<title>([\s\S]*?)<\/title>/.exec(content);
  return match ? match[1] : "";
}

// ---------------------------------------------------------------- multipart 解析

interface MultipartBody {
  fields: Record<string, string>;
  file?: Buffer;
}

function parseMultipart(body: Buffer, contentType: string): MultipartBody {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw new Error(`upload_all 的 Content-Type 里没有 boundary：${JSON.stringify(contentType)}`);
  const boundary = (match[1] ?? match[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`, "latin1");

  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw new Error("multipart body 里找不到 boundary 分隔符");

  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString("latin1") === "--") break; // 结束分隔符
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    let part = body.subarray(start, next);
    if (part.subarray(0, 2).toString("latin1") === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString("latin1") === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) throw new Error("multipart 分段里没有找到头部结束标记");
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const payload = part.subarray(headerEnd + 4);
    const nameMatch = /\bname="([^"]*)"/i.exec(headerText);
    if (!nameMatch) throw new Error(`multipart 分段缺少 name：${headerText}`);
    const name = nameMatch[1];
    if (/filename=/i.test(headerText)) file = Buffer.from(payload);
    else fields[name] = payload.toString("utf8");
    cursor = next;
  }

  return { fields, file };
}

// ---------------------------------------------------------------- 假飞书服务器

interface FakeNode {
  nodeToken: string;
  objToken: string;
  objType: string;
  parentNodeToken: string | undefined;
  title: string;
  nodeType: string;
}

interface FakeFileEntry {
  token: string;
  title: string;
  bytes: Buffer;
  version: number;
  modifiedTime: number;
  nodeToken?: string;
}

interface UploadRecord {
  relPath?: string;
  fileName: string;
  sizeField: number;
  actualSize: number;
  parentType: string;
  parentNode: string;
  fileToken?: string;
  /** 假服务器故意拒绝的请求（不会真的落地） */
  rejected?: boolean;
}

/** 文档里的图片块：占位块（marker 来自 <img path="@lcli_img_…"/>）或远端直接插入的图片。 */
interface FakeImageBlock {
  blockId: string;
  marker: string;
  caption: string;
  fileToken?: string;
}

/** docs_ai 建出来的新版文档（docx），只有往返转换实测这条命令会用到。 */
interface FakeDocument {
  documentId: string;
  title: string;
  /** 最近一次写入的 markdown（含 <title> 标签与 <img path> 占位） */
  content: string;
  revision: number;
  url: string;
  nodeToken?: string;
  /** 飞书返回的「最后修改时间」（Unix 秒字符串），内容被改动时递增 */
  modifyTime: string;
  /** 正文占位块，顺序与 content 里的 <img path> 标记一致 */
  blocks: FakeImageBlock[];
  /** 模拟别人在飞书里插入的图片：排在正文之后 */
  remoteImages: FakeImageBlock[];
}

interface MediaUploadRecord {
  documentId: string;
  blockId: string;
  fileName: string;
  parentType: string;
  size: number;
  actualSize: number;
  fileToken: string;
}

interface DocsRequest {
  label: string;
  body: Record<string, unknown>;
}

interface FakeCounters {
  spaces: number;
  uploadAll: number;
  download: number;
  meta: number;
  nodeList: number;
  nodeCreate: number;
  nodeByToken: number;
  move: number;
  docsCreate: number;
  docsUpdate: number;
  docsFetch: number;
  docsTaskPoll: number;
  deleteFile: number;
  mediaUpload: number;
  mediaDownload: number;
  blockBind: number;
  blockDelete: number;
}

class FakeFeishu {
  readonly nodes = new Map<string, FakeNode>();
  readonly files = new Map<string, FakeFileEntry>();
  readonly uploads: UploadRecord[] = [];
  readonly duplicateTitles: { parentNodeToken: string; title: string; objType: string; nodeTokens: string[] }[] = [];
  readonly emptyDownloadTokens = new Set<string>();
  readonly metaRequests: { withUrl: unknown; docTypes: string[] }[] = [];
  /** POST /nodes 建容器节点的请求记录（含是否带 parent_node_token） */
  readonly nodeCreations: { title: string; hasParentField: boolean; parentNodeToken?: string; nodeToken: string }[] = [];
  /** 置 true 后，parent_type=wiki 的直传会返回错误，用来触发云空间中转兜底路径。 */
  rejectWikiUploads = false;
  readonly unknownRoutes: string[] = [];
  readonly counters: FakeCounters = {
    spaces: 0,
    uploadAll: 0,
    download: 0,
    meta: 0,
    nodeList: 0,
    nodeCreate: 0,
    nodeByToken: 0,
    move: 0,
    docsCreate: 0,
    docsUpdate: 0,
    docsFetch: 0,
    docsTaskPoll: 0,
    deleteFile: 0,
    mediaUpload: 0,
    mediaDownload: 0,
    blockBind: 0,
    blockDelete: 0,
  };
  /** DELETE /drive/v1/files/{token} 的请求记录 */
  readonly deleteRequests: { token: string; type: string }[] = [];
  /** 素材上传记录（校验 parent_type / parent_node / extra.drive_route_token） */
  readonly mediaUploads: MediaUploadRecord[] = [];
  /** 绑定请求记录（requests[].block_id + replace_image.token） */
  readonly bindRequests: { documentId: string; blockId: string; fileToken: string }[] = [];
  /** 素材池：file_token → 字节 */
  readonly media = new Map<string, { bytes: Buffer; fileName: string }>();
  /** 置 true 后素材下载返回 403，用来验证"下载失败保留引用、不中断拉取" */
  rejectMediaDownload = false;
  /** 置 true 后图片 URL 里不带素材 token，逼客户端走文档块顺序兜底 */
  docImagePlainUrl = false;
  /** 置 true 后 drive/v1/metas/batch_query 返回错误，用来验证"元数据失败退回逐篇取回" */
  rejectMetaQuery = false;
  /** 文档「最后修改时间」的假时钟（Unix 秒） */
  private docClock = 1790004891;

  private tickDocTime(): string {
    this.docClock += 1;
    return String(this.docClock);
  }
  /** 置 true 后所有删除请求都失败，用来验证"删除失败保留映射、下次重试" */
  rejectDeletes = false;
  /** docs_ai 建出来的文档 */
  readonly documents = new Map<string, FakeDocument>();
  /** docs_ai 请求记录（往返转换实测要核对请求形状） */
  readonly docsRequests: DocsRequest[] = [];
  /** 创建是否返回 task_id：true 走异步轮询路径 */
  docsCreateAsync = true;
  /** 模拟转换损失：取回时丢掉这几行（待办勾选、callout、frontmatter、图片） */
  docsFidelityLoss = true;
  /** 模拟实测的格式规范化：<title> 变成首行 H1、行首 Tab 变空格（文档模式场景用） */
  docsNormalize = false;
  /** 模拟更新路径不稳定：第二次取回时多出一行 */
  docsDriftOnSecondFetch = false;
  private docsFetches = 0;
  private readonly docTasks = new Map<string, { documentId: string; polls: number }>();
  /** move_docs_to_wiki 的请求记录（要核对 obj_type=docx） */
  readonly moveRequests: { parentWikiToken?: string; objToken?: string; objType?: string; apply?: boolean }[] = [];

  /** 当前存着的文档内容（发送形态，带 <title> 标签） */
  docContent(documentId: string): string | undefined {
    return this.documents.get(documentId)?.content;
  }

  /** 模拟"有人在飞书那边删掉了这篇文档"：文档与节点一起消失 */
  removeDocumentNode(documentId: string): void {
    const document = this.documents.get(documentId);
    if (document?.nodeToken) this.nodes.delete(document.nodeToken);
    this.documents.delete(documentId);
  }

  /** 文档当前的「最后修改时间」（断言用） */
  docModifyTimeOf(documentId: string): string | undefined {
    return this.documents.get(documentId)?.modifyTime;
  }

  /** 取回形态的 Markdown（与 fetch 端点给客户端的完全一致），断言用 */
  docMarkdown(documentId: string): string {
    const document = this.documents.get(documentId);
    if (!document) throw new Error(`未知 document_id：${documentId}`);
    return this.convertToMarkdown(document);
  }

  /** 文档里的图片块（含远端直接插入的），断言用 */
  docImageBlocks(documentId: string): { blockId: string; caption: string; fileToken?: string }[] {
    const document = this.documents.get(documentId);
    if (!document) throw new Error(`未知 document_id：${documentId}`);
    return this.allImageBlocks(document).map((block) => ({ blockId: block.blockId, caption: block.caption, fileToken: block.fileToken }));
  }

  /** 模拟"有人在飞书里插了一张图"：素材先进池子，再作为远端图片块追加到文档末尾 */
  insertRemoteImage(documentId: string, options: { caption: string; bytes: Buffer; fileName: string }): string {
    const document = this.documents.get(documentId);
    if (!document) throw new Error(`未知 document_id：${documentId}`);
    const fileToken = this.nextToken("imgToken");
    this.media.set(fileToken, { bytes: options.bytes, fileName: options.fileName });
    document.remoteImages.push({ blockId: this.nextToken("blkImg"), marker: "", caption: options.caption, fileToken });
    document.revision += 1;
    document.modifyTime = this.tickDocTime();
    return fileToken;
  }

  /** 模拟"有人在飞书那边删掉了这篇 md 文件"：文件与节点一起消失 */
  removeRemoteFile(relPath: string): void {
    const node = this.fileNodeAt(relPath);
    ok(node, `removeRemoteFile：远端不存在 ${relPath}`);
    this.nodes.delete(node.nodeToken);
    this.files.delete(node.objToken);
  }

  /** 直接改远端文档内容，模拟"有人在飞书侧编辑了这篇文档" */
  setDocContent(documentId: string, content: string): void {
    const document = this.documents.get(documentId);
    if (!document) throw new Error(`未知 document_id：${documentId}`);
    document.content = content;
    document.title = docTitleOf(content) || document.title;
    document.revision += 1;
    document.modifyTime = this.tickDocTime();
  }

  /** 只改内容、不动「最后修改时间」：用来复现"同一秒内的改动被时间戳快路径漏判"这一极端情况 */
  editDocContentWithoutTimeBump(documentId: string, content: string): void {
    const document = this.documents.get(documentId);
    if (!document) throw new Error(`未知 document_id：${documentId}`);
    document.content = content;
    document.title = docTitleOf(content) || document.title;
    document.revision += 1;
  }

  /** 老模式（指定同步根节点）预置的那个根节点 token；新模式为 undefined（空间顶层就是根）。 */
  readonly rootToken: string | undefined;
  /**
   * 新模式里"存放 vault 根目录笔记的那个顶层页面"的 node_token。
   * 与 walkWikiTree 的 rootContainerNode 同义：算路径时要把这一层前缀剥掉。
   */
  rootContainerNode?: string;

  private seq = 0;
  private clock = 1000;

  constructor(options: { seedRootNode?: boolean } = {}) {
    const seed = options.seedRootNode !== false;
    this.rootToken = seed ? ROOT_NODE : undefined;
    if (seed) {
      this.nodes.set(ROOT_NODE, {
        nodeToken: ROOT_NODE,
        objToken: "doxcn_root",
        objType: "docx",
        parentNodeToken: undefined,
        title: "Work",
        nodeType: "origin",
      });
    }
  }

  // ---- 内部工具

  private nextToken(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private ok(data: unknown): RequestUrlResponse {
    const text = JSON.stringify({ code: 0, msg: "ok", data, log_id: "t" });
    return { status: 200, headers: { "content-type": "application/json" }, text, arrayBuffer: toArrayBuffer(Buffer.from(text, "utf8")) };
  }

  private fail(status: number, code: number, msg: string): RequestUrlResponse {
    const text = JSON.stringify({ code, msg, log_id: "t" });
    return { status, headers: { "content-type": "application/json" }, text, arrayBuffer: toArrayBuffer(Buffer.from(text, "utf8")) };
  }

  private hasChild(nodeToken: string): boolean {
    for (const node of this.nodes.values()) if (node.parentNodeToken === nodeToken) return true;
    return false;
  }

  private createNode(input: FakeNode): FakeNode {
    const siblings = [...this.nodes.values()].filter(
      (node) => node.parentNodeToken === input.parentNodeToken && node.title === input.title && node.nodeToken !== input.nodeToken,
    );
    if (siblings.length > 0) {
      this.duplicateTitles.push({
        parentNodeToken: String(input.parentNodeToken),
        title: input.title,
        objType: input.objType,
        nodeTokens: [...siblings.map((node) => node.nodeToken), input.nodeToken],
      });
    }
    this.nodes.set(input.nodeToken, input);
    return input;
  }

  private wireNode(node: FakeNode): Record<string, unknown> {
    return {
      node_token: node.nodeToken,
      obj_token: node.objToken,
      obj_type: node.objType,
      parent_node_token: node.parentNodeToken,
      node_type: node.nodeType,
      title: node.title,
      has_child: this.hasChild(node.nodeToken),
    };
  }

  /**
   * 节点在知识库里的相对路径。
   * - 老模式：不含预置根节点的标题；
   * - 新模式：不含"存放 vault 根目录笔记的顶层页面"（rootContainerNode），与 walkWikiTree 的路径口径一致。
   */
  relPathOfNode(nodeToken: string, rootContainerNode: string | undefined = this.rootContainerNode): string {
    const parts: string[] = [];
    let current: FakeNode | undefined = this.nodes.get(nodeToken);
    while (current) {
      if (current.nodeToken === this.rootToken) break;
      if (rootContainerNode && current.nodeToken === rootContainerNode) break;
      parts.unshift(current.title);
      current = current.parentNodeToken ? this.nodes.get(current.parentNodeToken) : undefined;
    }
    return parts.join("/");
  }

  /** 空间一级节点（parent_node_token 为空）。 */
  topLevelNodes(): FakeNode[] {
    return [...this.nodes.values()].filter((node) => !node.parentNodeToken && node.objType !== "file");
  }

  topLevelNodesTitled(title: string): FakeNode[] {
    return this.topLevelNodes().filter((node) => node.title === title);
  }

  childrenOf(nodeToken: string | undefined): FakeNode[] {
    return [...this.nodes.values()].filter((node) => node.parentNodeToken === nodeToken);
  }

  // ---- 对外断言用辅助

  fileNodes(): FakeNode[] {
    return [...this.nodes.values()].filter((node) => node.objType === "file");
  }

  fileNodeAt(relPath: string): FakeNode | undefined {
    return this.fileNodes().find((node) => this.relPathOfNode(node.nodeToken) === relPath);
  }

  entryAt(relPath: string): FakeFileEntry | undefined {
    const node = this.fileNodeAt(relPath);
    return node ? this.files.get(node.objToken) : undefined;
  }

  remoteText(relPath: string): string {
    const entry = this.entryAt(relPath);
    ok(entry, `假服务器里找不到远端文件：${relPath}`);
    return entry.bytes.toString("utf8");
  }

  /** 模拟"有人在飞书那边改了"：改内容 + 递增 version / latest_modify_time。 */
  editRemote(relPath: string, newText: string): void {
    const node = this.fileNodeAt(relPath);
    ok(node, `editRemote：远端不存在 ${relPath}`);
    const entry = this.files.get(node.objToken);
    ok(entry, `editRemote：找不到 ${relPath} 的文件记录`);
    entry.bytes = Buffer.from(newText, "utf8");
    entry.version += 1;
    entry.modifiedTime = this.tick();
  }

  /**
   * 模拟"有人在飞书知识库里新建了一篇笔记"：缺的容器节点一并补上。
   * `options.inRootContainer` = true 时挂到 rootContainerNode（顶层根页面）下面，
   * 用来模拟"别人把笔记建在了那个存放 vault 根目录笔记的页面里"。
   */
  addRemoteFile(relPath: string, text: string, options: { insideRootContainer?: boolean } = {}): void {
    const segments = relPath.split("/");
    const fileName = segments.pop() as string;
    let parent: string | undefined = this.rootToken;
    if (options.insideRootContainer) {
      ok(this.rootContainerNode, "addRemoteFile：还没有顶层根页面");
      parent = this.rootContainerNode;
    }
    for (const segment of segments) {
      let node = [...this.nodes.values()].find((item) => item.parentNodeToken === parent && item.title === segment);
      if (!node) {
        node = this.createNode({
          nodeToken: this.nextToken("wikcn"),
          objToken: this.nextToken("doxcn"),
          objType: "docx",
          parentNodeToken: parent,
          title: segment,
          nodeType: "origin",
        });
      }
      parent = node.nodeToken;
    }
    const objToken = this.nextToken("fldcn");
    const entry: FakeFileEntry = {
      token: objToken,
      title: fileName,
      bytes: Buffer.from(text, "utf8"),
      version: 1,
      modifiedTime: this.tick(),
      nodeToken: this.nextToken("wikcn"),
    };
    this.files.set(objToken, entry);
    this.createNode({
      nodeToken: entry.nodeToken as string,
      objToken,
      objType: "file",
      parentNodeToken: parent,
      title: fileName,
      nodeType: "origin",
    });
  }

  /** 模拟"有人在飞书知识库里删掉了这篇笔记"。 */
  removeRemoteFile(relPath: string): void {
    const node = this.fileNodeAt(relPath);
    ok(node, `removeRemoteFile：远端不存在 ${relPath}`);
    this.files.delete(node.objToken);
    this.nodes.delete(node.nodeToken);
  }

  fileTokenAt(relPath: string): string {
    const node = this.fileNodeAt(relPath);
    ok(node, `远端没有 ${relPath}`);
    return node.objToken;
  }

  // ---- 请求入口

  handler = (options: RequestUrlParam): Promise<RequestUrlResponse> => this.handle(options);

  private async handle(options: RequestUrlParam): Promise<RequestUrlResponse> {
    const url = new URL(options.url);
    const method = (options.method ?? "GET").toUpperCase();
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments[0] !== "open-apis") return this.fail(404, 1000, `未知路径 ${url.pathname}`);
    const route = segments.slice(1).join("/");

    if (route === "drive/v1/files/upload_all" && method === "POST") {
      this.counters.uploadAll += 1;
      return this.uploadAll(options);
    }
    if (route.startsWith("drive/v1/medias/") && route.endsWith("/preview_download") && method === "GET") {
      this.counters.download += 1;
      return this.previewDownload(segments[4]); // open-apis / drive / v1 / medias / <token> / preview_download
    }
    if (route === "drive/v1/metas/batch_query" && method === "POST") {
      this.counters.meta += 1;
      return this.batchQuery(JSON.parse(String(options.body)));
    }
    if (/^drive\/v1\/files\/[^/]+$/.test(route) && method === "DELETE") {
      this.counters.deleteFile += 1;
      return this.deleteDriveObject(segments[4], url.searchParams.get("type") ?? "");
    }
    if (route === "wiki/v2/spaces" && method === "GET") {
      this.counters.spaces += 1;
      return this.ok({
        items: [{ space_id: SPACE_ID, name: "E2E 测试空间", description: "假服务器", space_type: "team", visibility: "private" }],
        has_more: false,
      });
    }
    if (route === "wiki/v2/spaces/node_by_token" && method === "GET") {
      this.counters.nodeByToken += 1;
      return this.nodeByToken(url.searchParams.get("token") ?? "", url.searchParams.get("obj_type") ?? undefined);
    }
    if (/^wiki\/v2\/spaces\/[^/]+\/nodes$/.test(route)) {
      if (method === "GET") {
        this.counters.nodeList += 1;
        return this.listNodes(url);
      }
      if (method === "POST") {
        this.counters.nodeCreate += 1;
        return this.createContainerNode(JSON.parse(String(options.body)));
      }
    }
    if (/^wiki\/v2\/spaces\/[^/]+\/nodes\/move_docs_to_wiki$/.test(route) && method === "POST") {
      this.counters.move += 1;
      return this.moveDocsToWiki(JSON.parse(String(options.body)));
    }
    if (route === "drive/v1/medias/upload_all" && method === "POST") {
      this.counters.mediaUpload += 1;
      return this.mediaUploadAll(options);
    }
    if (/^drive\/v1\/medias\/[^/]+\/download$/.test(route) && method === "GET") {
      this.counters.mediaDownload += 1;
      return this.mediaDownload(segments[4]);
    }
    if (/^docx\/v1\/documents\/[^/]+\/blocks\/batch_update$/.test(route) && method === "PATCH") {
      this.counters.blockBind += 1;
      return this.docBlockBatchUpdate(segments[4], JSON.parse(String(options.body)));
    }
    if (/^docx\/v1\/documents\/[^/]+\/blocks$/.test(route) && method === "GET") {
      return this.docBlockList(segments[4]);
    }
    if (/^docx\/v1\/documents\/[^/]+\/blocks\/[^/]+$/.test(route) && method === "GET") {
      return this.docBlockGet(segments[4], segments[6]);
    }
    if (route === "docs_ai/v1/documents" && method === "POST") {
      this.counters.docsCreate += 1;
      return this.docsCreate(JSON.parse(String(options.body)));
    }
    if (/^docs_ai\/v1\/async_tasks\/[^/]+$/.test(route) && method === "GET") {
      this.counters.docsTaskPoll += 1;
      return this.docsAsyncTask(segments[4]);
    }
    if (/^docs_ai\/v1\/documents\/[^/]+\/fetch$/.test(route) && method === "POST") {
      this.counters.docsFetch += 1;
      return this.docsFetch(segments[4], JSON.parse(String(options.body)));
    }
    if (/^docs_ai\/v1\/documents\/[^/]+$/.test(route) && method === "PUT") {
      this.counters.docsUpdate += 1;
      return this.docsUpdate(segments[4], JSON.parse(String(options.body)));
    }

    this.unknownRoutes.push(`${method} ${url.pathname}`);
    return this.fail(404, 1000, `假服务器未实现 ${method} ${url.pathname}`);
  }

  // ---- docs_ai（往返转换实测）

  /** 假转换：把 markdown 原样存下来，顺便留一份"转换前"的原文，取回时再按需做有损改写。 */
  private docsCreate(body: { format?: string; content?: string; extra_param?: string; parent_token?: string }): RequestUrlResponse {
    this.docsRequests.push({ label: "POST /open-apis/docs_ai/v1/documents", body: { ...body } });
    const content = String(body.content ?? "");
    const documentId = this.nextToken("doxcnP");
    const document: FakeDocument = {
      documentId,
      title: docTitleOf(content),
      content,
      revision: 1,
      modifyTime: this.tickDocTime(),
      url: `https://example.feishu.cn/docx/${documentId}`,
      blocks: this.placeholderBlocks(content),
      remoteImages: [],
    };
    this.documents.set(documentId, document);
    if (this.docsCreateAsync) {
      const taskId = this.nextToken("task");
      this.docTasks.set(taskId, { documentId, polls: 0 });
      return this.ok({ task: { task_id: taskId, status: "processing", stage: "converting", poll_after_ms: 1 } });
    }
    return this.ok({ document: { document_id: documentId, url: document.url, new_blocks: this.wireNewBlocks(document) } });
  }

  private docsAsyncTask(taskId: string): RequestUrlResponse {
    const task = this.docTasks.get(taskId);
    if (!task) return this.fail(200, 1770003, `未知 task_id：${taskId}`);
    task.polls += 1;
    // 第一次一定是 processing，逼客户端真的轮询一轮
    if (task.polls < 2) {
      return this.ok({ task: { task_id: taskId, status: "processing", stage: "converting", poll_after_ms: 1 } });
    }
    const document = this.documents.get(task.documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${task.documentId}`);
    return this.ok({
      task: {
        task_id: taskId,
        status: "succeeded",
        // 真实接口里 create_document 是 JSON 字符串
        result: {
          create_document: JSON.stringify({
            document: { document_id: document.documentId, url: document.url, new_blocks: this.wireNewBlocks(document) },
          }),
        },
      },
    });
  }

  private docsUpdate(documentId: string, body: { format?: string; command?: string; revision_id?: number; content?: string; block_id?: string }): RequestUrlResponse {
    this.docsRequests.push({ label: `PUT /open-apis/docs_ai/v1/documents/${documentId}`, body: { ...body } });
    const document = this.documents.get(documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${documentId}`);

    if (String(body.command ?? "") === "block_delete") {
      // 官方清理占位块的方式：docs_ai 的 block_delete
      const targets = new Set(String(body.block_id ?? "").split(",").filter(Boolean));
      const before = document.blocks.length + document.remoteImages.length;
      document.blocks = document.blocks.filter((block) => !targets.has(block.blockId));
      document.remoteImages = document.remoteImages.filter((block) => !targets.has(block.blockId));
      if (before === document.blocks.length + document.remoteImages.length && targets.size > 0) {
        return this.fail(200, 1770004, `block_delete 没找到要删的块：${String(body.block_id)}`);
      }
      this.counters.blockDelete += targets.size;
      document.revision += 1;
      document.modifyTime = this.tickDocTime();
      return this.ok({ document: { document_id: documentId }, revision_id: document.revision });
    }

    document.content = String(body.content ?? "");
    document.title = docTitleOf(document.content) || document.title;
    document.blocks = this.placeholderBlocks(document.content);
    document.revision += 1;
    document.modifyTime = this.tickDocTime();
    return this.ok({
      document: { document_id: documentId, new_blocks: this.wireNewBlocks(document) },
      revision_id: document.revision,
    });
  }

  /**
   * 解析 content 里的 <img path="@lcli_img_<hex>" caption="…"/> 占位：每个标记对应一个图片块，
   * 覆盖写入时块 id 会重新生成（等价于飞书重建了占位块）。
   */
  private placeholderBlocks(content: string): FakeImageBlock[] {
    const blocks: FakeImageBlock[] = [];
    const pattern = /<img\s+path="(@lcli_img_[0-9a-f]{32})"(?:\s+caption="([^"]*)")?\s*\/>/g;
    let match = pattern.exec(content);
    while (match) {
      blocks.push({ blockId: this.nextToken("blkImg"), marker: match[1], caption: match[2] ?? "" });
      match = pattern.exec(content);
    }
    return blocks;
  }

  private wireNewBlocks(document: FakeDocument): Record<string, unknown>[] {
    return document.blocks.map((block) => ({
      block_id: block.blockId,
      block_token: block.marker,
      block_type: "image",
    }));
  }

  private allImageBlocks(document: FakeDocument): FakeImageBlock[] {
    return [...document.blocks, ...document.remoteImages];
  }

  /** 图片在取回 Markdown 里的地址形态：默认带素材 token，docImagePlainUrl 时不带（逼出顺序兜底）。 */
  private imageUrl(fileToken: string): string {
    if (this.docImagePlainUrl) return "https://internal.example/space/api/box/stream/download/v2/cover/?size=1024";
    return `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`;
  }

  private mediaUploadAll(options: RequestUrlParam): RequestUrlResponse {
    const contentType = headerOf(options, "content-type");
    const rawBody = typeof options.body === "string" ? Buffer.from(options.body, "utf8") : Buffer.from(options.body as ArrayBuffer);
    const { fields, file } = parseMultipart(rawBody, contentType);
    if (fields.parent_type !== "docx_image") return this.fail(200, 1061008, `素材 parent_type 必须是 docx_image，收到 ${fields.parent_type ?? ""}`);
    let routeToken = "";
    try {
      routeToken = String((JSON.parse(fields.extra ?? "{}") as { drive_route_token?: string }).drive_route_token ?? "");
    } catch {
      return this.fail(200, 1061009, `素材 extra 不是合法 JSON：${fields.extra ?? ""}`);
    }
    const document = this.documents.get(routeToken);
    if (!document) return this.fail(200, 1770001, `素材 extra.drive_route_token 不是已知文档：${routeToken}`);
    const block = this.allImageBlocks(document).find((item) => item.blockId === fields.parent_node);
    if (!block) return this.fail(200, 1770002, `素材 parent_node 不是该文档的图片块：${fields.parent_node ?? ""}`);
    if (!file) return this.fail(200, 1061010, "素材上传缺少 file 分段");

    const fileToken = this.nextToken("imgToken");
    this.media.set(fileToken, { bytes: file, fileName: fields.file_name ?? "" });
    this.mediaUploads.push({
      documentId: routeToken,
      blockId: fields.parent_node ?? "",
      fileName: fields.file_name ?? "",
      parentType: fields.parent_type,
      size: Number(fields.size),
      actualSize: file.length,
      fileToken,
    });
    return this.ok({ file_token: fileToken });
  }

  private mediaDownload(fileToken: string): RequestUrlResponse {
    if (this.rejectMediaDownload) return this.fail(403, 1061002, "假服务器模拟素材下载被拒");
    const entry = this.media.get(fileToken);
    if (!entry) return this.fail(404, 1061002, `未知素材 token：${fileToken}`);
    const lower = entry.fileName.toLowerCase();
    const contentType = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : lower.endsWith(".svg") ? "image/svg+xml" : "image/png";
    return { status: 200, headers: { "content-type": contentType }, text: "", arrayBuffer: toArrayBuffer(entry.bytes) };
  }

  private docBlockBatchUpdate(documentId: string, body: { requests?: { block_id?: string; replace_image?: { token?: string } }[] }): RequestUrlResponse {
    const document = this.documents.get(documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${documentId}`);
    for (const request of body?.requests ?? []) {
      const blockId = String(request.block_id ?? "");
      const fileToken = String(request.replace_image?.token ?? "");
      const block = this.allImageBlocks(document).find((item) => item.blockId === blockId);
      if (!block) return this.fail(200, 1770005, `未知 block_id：${blockId}`);
      if (!this.media.has(fileToken)) return this.fail(200, 1061002, `replace_image.token 不是已知素材：${fileToken}`);
      block.fileToken = fileToken;
      this.bindRequests.push({ documentId, blockId, fileToken });
    }
    document.revision += 1;
    return this.ok({ document_revision_id: document.revision });
  }

  private docBlockGet(documentId: string, blockId: string): RequestUrlResponse {
    const document = this.documents.get(documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${documentId}`);
    const block = this.allImageBlocks(document).find((item) => item.blockId === blockId);
    if (!block) return this.fail(200, 1770005, `未知 block_id：${blockId}`);
    return this.ok({ block: this.wireBlock(block) });
  }

  private docBlockList(documentId: string): RequestUrlResponse {
    const document = this.documents.get(documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${documentId}`);
    return this.ok({ items: this.allImageBlocks(document).map((block) => this.wireBlock(block)), has_more: false });
  }

  private wireBlock(block: FakeImageBlock): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      block_id: block.blockId,
      block_type: 27,
      image: block.fileToken ? { token: block.fileToken } : {},
    };
    return wire;
  }

  private docsFetch(documentId: string, body: { format?: string; extra_param?: string; export_option?: unknown }): RequestUrlResponse {
    this.docsRequests.push({ label: `POST /open-apis/docs_ai/v1/documents/${documentId}/fetch`, body: { ...body } });
    const document = this.documents.get(documentId);
    if (!document) return this.fail(200, 1770001, `未知 document_id：${documentId}`);
    this.docsFetches += 1;
    return this.ok({ document: { document_id: documentId, content: this.convertToMarkdown(document) } });
  }

  /** 正文里的占位标记按块状态取回：绑定过的是图片，没绑定的是空占位（取回时什么都没有）。 */
  private resolveImagePlaceholders(document: FakeDocument, content: string): string {
    let out = content;
    for (const block of document.blocks) {
      const tag = new RegExp(`<img\\s+path="${block.marker}"(?:\\s+caption="[^"]*")?\\s*\\/>\\n?`);
      const replacement = block.fileToken ? `![${block.caption}](${this.imageUrl(block.fileToken)})\n` : "";
      out = out.replace(tag, replacement);
    }
    return out;
  }

  /** 按官方转换的常见损失改写几行，用来验证报告里的 ❌ 判定不是恒真。 */
  private convertToMarkdown(document: FakeDocument): string {
    if (this.docsNormalize) {
      // 实测行为：<title> 取回成首行 H1，行首 Tab 变空格
      const title = docTitleOf(document.content);
      const normalized = document.content
        .split("\n")
        .map((line) => line.replace(/\t/g, "  "))
        .join("\n");
      const withoutTag = normalized.includes("</title>")
        ? normalized.slice(normalized.indexOf("</title>") + "</title>".length).replace(/^\n/, "")
        : normalized;
      const body = this.resolveImagePlaceholders(document, withoutTag);
      const remote = document.remoteImages
        .filter((block) => block.fileToken)
        .map((block) => `![${block.caption}](${this.imageUrl(block.fileToken as string)})`)
        .join("\n");
      return this.applyDrift(`${title ? `# ${title}\n` : ""}${body}${remote ? `${remote}\n` : ""}`);
    }

    let lines = document.content.split("\n");
    if (this.docsFidelityLoss) {
      lines = lines
        .filter((line) => line !== "roundtrip_probe: true" && line !== "> [!note] 提示")
        .map((line) => line.replace("- [ ] 待办：确认这一行是否原样回来", "- 待办：确认这一行是否原样回来"))
        .map((line) => (line.includes("![[Pasted image") ? "![图片](https://example.feishu.cn/img/pasted)" : line));
    }
    return this.applyDrift(lines.join("\n"));
  }

  private applyDrift(content: string): string {
    if (!this.docsDriftOnSecondFetch || this.docsFetches < 2) return content;
    return `${content}\n\n<!-- 服务端第二次取回漂移 -->`;
  }

  // ---- 各端点

  private uploadAll(options: RequestUrlParam): RequestUrlResponse {
    const contentType = headerOf(options, "content-type");
    const rawBody = typeof options.body === "string" ? Buffer.from(options.body, "utf8") : Buffer.from(options.body as ArrayBuffer);
    const { fields, file } = parseMultipart(rawBody, contentType);
    if (!file) return this.fail(200, 1061001, "upload_all 缺少 file 分段");

    const fileName = fields.file_name ?? "";
    const parentType = fields.parent_type ?? "";
    const parentNode = fields.parent_node ?? "";
    const sizeField = Number(fields.size);
    const parentRel = parentNode && this.nodes.has(parentNode) ? this.relPathOfNode(parentNode) : undefined;

    const attempt: UploadRecord = {
      relPath: parentRel === undefined ? undefined : parentRel ? `${parentRel}/${fileName}` : fileName,
      fileName,
      sizeField,
      actualSize: file.length,
      parentType,
      parentNode,
      fileToken: fields.file_token,
      rejected: this.rejectWikiUploads && parentType === "wiki",
    };
    this.uploads.push(attempt);

    if (attempt.rejected) return this.fail(200, 1061006, "parent_type=wiki 直传不被支持（假服务器模拟）");

    if (fields.file_token) {
      const entry = this.files.get(fields.file_token);
      if (!entry) return this.fail(200, 1061004, `未知 file_token：${fields.file_token}`);
      entry.bytes = file;
      entry.version += 1;
      entry.modifiedTime = this.tick();
      if (fileName) {
        entry.title = fileName;
        const node = entry.nodeToken ? this.nodes.get(entry.nodeToken) : undefined;
        if (node) node.title = fileName;
      }
      return this.ok({ file_token: entry.token });
    }

    const objToken = this.nextToken("fldcn");
    const nodeToken = this.nextToken("wikcn");
    const entry: FakeFileEntry = { token: objToken, title: fileName, bytes: file, version: 1, modifiedTime: this.tick() };
    this.files.set(objToken, entry);

    if (parentType === "wiki") {
      if (!parentNode) return this.fail(200, 1061002, "parent_type=wiki 时必须带 parent_node");
      if (!this.nodes.has(parentNode)) return this.fail(200, 1061003, `未知 parent_node：${parentNode}`);
      entry.nodeToken = nodeToken;
      this.createNode({ nodeToken, objToken, objType: "file", parentNodeToken: parentNode, title: fileName, nodeType: "origin" });
    }
    return this.ok({ file_token: objToken });
  }

  /** 删除云空间文件/文档：对应的 wiki 节点一并消失（与真实行为一致），删除进回收站可恢复。 */
  private deleteDriveObject(token: string, type: string): RequestUrlResponse {
    this.deleteRequests.push({ token, type });
    if (this.rejectDeletes) return this.fail(200, 1061004, "假服务器模拟删除失败（权限不足）");
    if (type === "docx") {
      const document = this.documents.get(token);
      if (!document) return this.fail(200, 1770001, `未知 document_id：${token}`);
      if (document.nodeToken) this.nodes.delete(document.nodeToken);
      this.documents.delete(token);
      return this.ok({});
    }
    if (type !== "file") return this.fail(200, 1061007, `delete 的 type 只能是 file|docx，收到 ${type}`);
    const entry = this.files.get(token);
    if (!entry) return this.fail(200, 1061002, `未知 file_token：${token}`);
    if (entry.nodeToken) this.nodes.delete(entry.nodeToken);
    this.files.delete(token);
    return this.ok({});
  }

  private previewDownload(token: string): RequestUrlResponse {    const entry = this.files.get(token);
    if (!entry) return this.fail(404, 1061002, `未知 file_token：${token}`);
    if (this.emptyDownloadTokens.has(token)) {
      // 模拟网关返回 200 + 0 字节
      return { status: 200, headers: { "content-type": "application/octet-stream" }, text: "", arrayBuffer: new ArrayBuffer(0) };
    }
    return { status: 200, headers: { "content-type": "text/markdown" }, text: "", arrayBuffer: toArrayBuffer(entry.bytes) };
  }

  private batchQuery(body: { request_docs?: { doc_token?: string; doc_type?: string }[]; with_url?: boolean }): RequestUrlResponse {
    this.metaRequests.push({
      withUrl: body?.with_url,
      docTypes: [...new Set((body?.request_docs ?? []).map((doc) => String(doc.doc_type)))],
    });
    if (this.rejectMetaQuery) return this.fail(200, 1061045, "假服务器模拟元数据接口失败");
    const metas: Record<string, unknown>[] = [];
    for (const doc of body?.request_docs ?? []) {
      if (doc.doc_type === "docx") {
        const document = doc.doc_token ? this.documents.get(doc.doc_token) : undefined;
        if (!document) continue;
        metas.push({
          doc_token: document.documentId,
          doc_type: "docx",
          title: document.title,
          url: document.url,
          latest_modify_time: document.modifyTime,
        });
        continue;
      }
      const entry = doc.doc_token ? this.files.get(doc.doc_token) : undefined;
      if (!entry) continue;
      metas.push({
        doc_token: entry.token,
        doc_type: doc.doc_type ?? "file",
        title: entry.title,
        url: `https://example.feishu.cn/file/${entry.token}`,
        latest_modify_time: String(entry.modifiedTime),
      });
    }
    return this.ok({ metas, failed_list: [] });
  }

  private nodeByToken(token: string, objType?: string): RequestUrlResponse {
    const all = [...this.nodes.values()];
    const node =
      all.find((item) => (!objType || item.objType === objType) && (item.objToken === token || item.nodeToken === token)) ??
      all.find((item) => item.objToken === token || item.nodeToken === token);
    if (!node) return this.fail(200, 131006, `未知节点 token：${token}`);
    return this.ok({ node: this.wireNode(node) });
  }

  private listNodes(url: URL): RequestUrlResponse {
    const parentParam = url.searchParams.get("parent_node_token") ?? "";
    const parent = parentParam || undefined;
    const pageSize = Number(url.searchParams.get("page_size") ?? 50) || 50;
    const offset = Number(url.searchParams.get("page_token") ?? 0) || 0;
    const all = [...this.nodes.values()].filter((node) => node.parentNodeToken === parent);
    const slice = all.slice(offset, offset + pageSize);
    const consumed = offset + slice.length;
    return this.ok({
      items: slice.map((node) => this.wireNode(node)),
      has_more: consumed < all.length,
      page_token: consumed < all.length ? String(consumed) : undefined,
    });
  }

  private createContainerNode(body: { obj_type?: string; node_type?: string; title?: string; parent_node_token?: string }): RequestUrlResponse {
    if (body?.obj_type !== "docx") return this.fail(200, 131001, `建容器节点只支持 docx，收到 ${String(body?.obj_type)}`);
    // 不带 parent_node_token = 在知识空间顶层建一级节点
    const parent = body.parent_node_token || undefined;
    if (parent && !this.nodes.has(parent)) return this.fail(200, 131002, `未知 parent_node_token：${parent}`);
    const node = this.createNode({
      nodeToken: this.nextToken("wikcn"),
      objToken: this.nextToken("doxcn"),
      objType: "docx",
      parentNodeToken: parent,
      title: body.title ?? "",
      nodeType: body.node_type ?? "origin",
    });
    this.nodeCreations.push({
      title: body.title ?? "",
      hasParentField: Boolean(body.parent_node_token),
      parentNodeToken: parent,
      nodeToken: node.nodeToken,
    });
    return this.ok({ node: this.wireNode(node) });
  }

  private moveDocsToWiki(body: { parent_wiki_token?: string; obj_token?: string; obj_type?: string; apply?: boolean }): RequestUrlResponse {
    this.moveRequests.push({
      parentWikiToken: body.parent_wiki_token,
      objToken: body.obj_token,
      objType: body.obj_type,
      apply: body.apply,
    });
    // 不带 parent_wiki_token = 移动到知识空间一级
    const parent = body.parent_wiki_token || undefined;
    if (parent && !this.nodes.has(parent)) return this.fail(200, 131003, `未知 parent_wiki_token：${parent}`);

    const document = body.obj_token ? this.documents.get(body.obj_token) : undefined;
    if (document) {
      if (document.nodeToken) return this.ok({ wiki_token: document.nodeToken });
      const nodeToken = this.nextToken("wikcn");
      document.nodeToken = nodeToken;
      this.createNode({
        nodeToken,
        objToken: document.documentId,
        objType: "docx",
        parentNodeToken: parent,
        title: document.title,
        nodeType: "origin",
      });
      return this.ok({ wiki_token: nodeToken });
    }

    const entry = body.obj_token ? this.files.get(body.obj_token) : undefined;
    if (!entry) return this.fail(200, 1061005, `未知 obj_token：${String(body.obj_token)}`);
    if (entry.nodeToken) return this.ok({ wiki_token: entry.nodeToken });
    const nodeToken = this.nextToken("wikcn");
    entry.nodeToken = nodeToken;
    this.createNode({
      nodeToken,
      objToken: entry.token,
      objType: body.obj_type === "docx" ? "docx" : "file",
      parentNodeToken: parent,
      title: entry.title,
      nodeType: "origin",
    });
    return this.ok({ wiki_token: nodeToken });
  }
}

// ---------------------------------------------------------------- 假 vault / App（真文件系统）

class FakeVault {
  private readonly cache = new Map<string, TFile>();

  constructor(
    private readonly root: string,
    private readonly name: string = path.basename(root),
  ) {}

  /** 与真实 Obsidian 的 Vault.getName() 对齐，用于断言默认根页面标题。 */
  getName(): string {
    return this.name;
  }

  private abs(relPath: string): string {
    return path.join(this.root, relPath);
  }

  private refresh(absPath: string): TFile {
    const rel = path.relative(this.root, absPath).split(path.sep).join("/");
    let file = this.cache.get(rel);
    if (!file) {
      file = new TFile();
      file.path = rel;
      file.name = path.basename(rel);
      file.basename = file.name.replace(/\.md$/, "");
      file.extension = "md";
      file.vault = this;
      this.cache.set(rel, file);
    }
    const stat = fs.statSync(absPath);
    file.stat = { size: stat.size, mtime: Math.floor(stat.mtimeMs), ctime: Math.floor(stat.birthtimeMs) };
    return file;
  }

  private walk(dir: string, out: TFile[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(abs, out);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(this.refresh(abs));
    }
  }

  getMarkdownFiles(): TFile[] {
    const out: TFile[] = [];
    this.walk(this.root, out);
    return out;
  }

  getAbstractFileByPath(relPath: string): TFile | { path: string; name: string } | null {
    const abs = this.abs(relPath);
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (stat.isFile()) return this.refresh(abs);
    if (stat.isDirectory()) return { path: relPath, name: path.basename(relPath) };
    return null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return toArrayBuffer(fs.readFileSync(this.abs(file.path)));
  }

  async read(file: TFile): Promise<string> {
    return fs.readFileSync(this.abs(file.path), "utf8");
  }

  async modify(file: TFile, data: string): Promise<void> {
    fs.writeFileSync(this.abs(file.path), data, "utf8");
    this.refresh(this.abs(file.path));
  }

  async create(relPath: string, data: string): Promise<TFile> {
    fs.mkdirSync(path.dirname(this.abs(relPath)), { recursive: true });
    fs.writeFileSync(this.abs(relPath), data, "utf8");
    return this.refresh(this.abs(relPath));
  }

  /** 模拟 Obsidian 的 vault.trash(file, false)：文件移进 .trash/ 下（不永久删除）。 */
  async trash(file: TFile, _system: boolean): Promise<void> {
    const target = path.join(this.root, ".trash", file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(this.abs(file.path), target);
    this.trashed.push(file.path);
    this.cache.delete(file.path);
  }

  /** 被移进 .trash 的相对路径（断言用） */
  readonly trashed: string[] = [];

  async cachedRead(file: TFile): Promise<string> {
    return fs.readFileSync(this.abs(file.path), "utf8");
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    fs.writeFileSync(this.abs(file.path), Buffer.from(data));
    this.refresh(this.abs(file.path));
  }

  async createBinary(relPath: string, data: ArrayBuffer): Promise<TFile> {
    fs.mkdirSync(path.dirname(this.abs(relPath)), { recursive: true });
    fs.writeFileSync(this.abs(relPath), Buffer.from(data));
    return this.refresh(this.abs(relPath));
  }

  async createFolder(relPath: string): Promise<{ path: string; name: string }> {
    fs.mkdirSync(this.abs(relPath), { recursive: true });
    return { path: relPath, name: path.basename(relPath) };
  }

  readonly adapter = {
    exists: async (relPath: string): Promise<boolean> => fs.existsSync(path.join(this.root, relPath)),
    read: async (relPath: string): Promise<string> => fs.readFileSync(path.join(this.root, relPath), "utf8"),
    write: async (relPath: string, data: string): Promise<void> => {
      fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
      fs.writeFileSync(path.join(this.root, relPath), data, "utf8");
    },
    writeBinary: async (relPath: string, data: ArrayBuffer): Promise<void> => {
      fs.mkdirSync(path.dirname(path.join(this.root, relPath)), { recursive: true });
      fs.writeFileSync(path.join(this.root, relPath), Buffer.from(data));
    },
    mkdir: async (relPath: string): Promise<void> => {
      fs.mkdirSync(path.join(this.root, relPath));
    },
  };
}

// ---------------------------------------------------------------- 测试脚手架

interface Harness {
  fake: FakeFeishu;
  vault: FakeVault;
  engine: SyncEngine;
  settings: PluginSettings;
  logs: { infos: string[]; warns: string[]; errors: string[]; debugs: string[] };
  saveCount: number;
}

function makeStubLogger(logs: Harness["logs"]): unknown {
  return {
    info: (message: string) => void logs.infos.push(message),
    warn: (message: string) => void logs.warns.push(message),
    error: (message: string) => void logs.errors.push(message),
    debug: (message: string) => void logs.debugs.push(message),
    flush: async () => undefined,
  };
}

function copyMarkdownTree(srcDir: string, destDir: string, out: string[], root: string = VAULT_ROOT): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .obsidian / .trash 等不算笔记
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyMarkdownTree(from, to, out, root);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    fs.copyFileSync(from, to);
    out.push(path.relative(root, to).split(path.sep).join("/"));
  }
}

function createHarness(
  fake: FakeFeishu,
  options: { vaultRoot?: string; vaultName?: string; settings?: Partial<PluginSettings> } = {},
): Harness {
  const vaultRoot = options.vaultRoot ?? VAULT_ROOT;
  const vault = new FakeVault(vaultRoot, options.vaultName ?? path.basename(vaultRoot));
  const app = {
    vault,
    workspace: { getLeavesOfType: () => [] },
  };
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    spaceId: SPACE_ID,
    rootNodeToken: ROOT_NODE,
    folderMode: "nodes",
    debugLog: false,
    state: emptyState(),
    ...options.settings,
  };
  const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[], debugs: [] as string[] };
  const logger = makeStubLogger(logs);
  const harness: Harness = {
    fake,
    vault,
    engine: new SyncEngine({
      app: app as never,
      getSettings: () => settings,
      saveSettings: async () => {
        harness.saveCount += 1;
        JSON.stringify(settings.state); // 状态必须可序列化
      },
      auth: { getToken: async () => "fake-token" } as never,
      logger: logger as never,
    }),
    settings,
    logs,
    saveCount: 0,
  };
  return harness;
}

interface RoundResult {
  plan: SyncPlan;
  report: ReportEntry[];
  executed: boolean;
  delta: FakeCounters;
  uploads: UploadRecord[];
}

async function runRound(
  h: Harness,
  label: string,
  options: Partial<RunOptions> & { mode: SyncMode },
  allowFallback = false,
): Promise<RoundResult> {
  const before = { ...h.fake.counters };
  const uploadFrom = h.fake.uploads.length;
  const result = await h.engine.run({ confirm: async () => "all", ...options });
  const after = h.fake.counters;
  const delta = Object.fromEntries(Object.keys(after).map((key) => [key, after[key as keyof FakeCounters] - before[key as keyof FakeCounters]])) as FakeCounters;
  const uploads = h.fake.uploads.slice(uploadFrom);
  assertUploads(uploads, label, allowFallback);

  console.log(`\n=== ${label} ===`);
  console.log(`  plan.counts : ${formatCounts(result.plan.counts)}`);
  console.log(`  report      : ${formatCounts(tally(result.report.map((entry) => `${entry.action}${entry.ok ? "" : "(失败)"}`)))}`);
  console.log(`  请求增量    : ${formatCounts(delta as unknown as Record<string, number>)}`);
  console.log(`  上传次数    : ${uploads.length}`);

  const failed = result.report.filter((entry) => !entry.ok);
  if (failed.length > 0) console.log(`  失败条目    : ${failed.map((entry) => `${entry.relPath}（${entry.message ?? ""}）`).join("; ")}`);

  return { plan: result.plan, report: result.report, executed: result.executed, delta, uploads };
}

function assertUploads(uploads: UploadRecord[], roundLabel: string, allowFallback = false): void {
  for (const upload of uploads) {
    if (!upload.rejected) {
      if (allowFallback) {
        ok(
          upload.parentType === "wiki" || upload.parentType === "explorer",
          `${roundLabel} 上传 ${upload.fileName} 的 parent_type 非法：${upload.parentType}`,
        );
      } else {
        eq(upload.parentType, "wiki", `${roundLabel} 上传 ${upload.fileName} 的 parent_type`);
      }
    }
    eq(upload.sizeField, upload.actualSize, `${roundLabel} 上传 ${upload.fileName} 的 size 字段与实际字节数`);
    ok(upload.fileName.endsWith(".md"), `${roundLabel} 上传的 file_name 不是 .md：${upload.fileName}`);
    ok(upload.actualSize > 0, `${roundLabel} 上传了 0 字节文件：${upload.fileName}`);
  }
}

function childItems(plan: SyncPlan, action: string): string[] {
  return plan.items.filter((entry) => entry.action === action).map((entry) => entry.relPath).sort();
}

/** 取报告里某个二级标题到下一个二级标题之间的内容。 */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

/** 取报告语法核对表里某条语法那一行（只在核对表那一段里找，避免匹配到正文代码块里的同名行）。 */
function reportRow(report: string, label: string): string {
  return sectionOf(report, "## 语法样本逐行核对")
    .split("\n")
    .find((line) => line.startsWith(`| ${label} `)) ?? "";
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function listConflictCopies(root: string = VAULT_ROOT): string[] {
  const dir = path.join(root, CONFLICT_DIR_REL);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return sorted(out);
}

function readVaultFile(relPath: string, root: string = VAULT_ROOT): string {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function writeVaultFile(relPath: string, text: string, root: string = VAULT_ROOT): void {
  fs.writeFileSync(path.join(root, relPath), text, "utf8");
}

function vaultFileSize(relPath: string, root: string = VAULT_ROOT): number {
  return fs.statSync(path.join(root, relPath)).size;
}

/** upload_all 的口径：parent_type 必须是 wiki，且 parent_node 必须非空（parent_node 是识别知识空间的依据）。 */
function assertUploadsHaveWikiParent(uploads: UploadRecord[], label: string): void {
  for (const upload of uploads) {
    if (upload.rejected) continue;
    eq(upload.parentType, "wiki", `${label} 上传 ${upload.fileName} 的 parent_type`);
    ok(upload.parentNode.length > 0, `${label} 上传 ${upload.fileName} 的 parent_node 为空`);
  }
}

/** walkWikiTree 每个"有子节点的容器 + 顶层自身"都会调一次 listNodes，用来精确核对 node_list 次数。 */
function countContainersWithChildren(fake: FakeFeishu): number {
  return [...fake.nodes.values()].filter((node) => node.objType !== "file" && fake.childrenOf(node.nodeToken).length > 0).length;
}

// ---------------------------------------------------------------- 文档模式脚手架

interface DocHarness {
  fake: FakeFeishu;
  vault: FakeVault;
  engine: DocSyncEngine;
  settings: PluginSettings;
  logs: Harness["logs"];
  saveCount: number;
}

/** 往临时 vault 里写一段二进制（图片附件）。 */
function writeVaultBinary(root: string, relPath: string, bytes: Buffer): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

/** 一个 1x1 PNG（图片上传/下载断言用，内容固定便于比对）。 */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** 只写 .md 的临时 vault（不碰真实 vault）。 */
function writeDocVault(root: string, files: Record<string, string>): void {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [relPath, text] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }
}

function createDocHarness(fake: FakeFeishu, vaultRoot: string, settings: Partial<PluginSettings> = {}): DocHarness {
  // 文档模式场景按实测行为建模：创建走异步任务、取回做格式规范化、没有额外的语法损失
  fake.docsCreateAsync = true;
  fake.docsFidelityLoss = false;
  fake.docsNormalize = true;
  docFakes.push({ label: path.basename(vaultRoot), fake });
  const vault = new FakeVault(vaultRoot, path.basename(vaultRoot));
  const app = {
    vault,
    workspace: { getLeavesOfType: () => [] },
    // 只实现文档模式图片规则用到的链接解析：按 vault 内相对路径找文件
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string): TFile | null => {
        const candidate = vault.getAbstractFileByPath(linkpath);
        return candidate instanceof TFile ? candidate : null;
      },
    },
  };
  const resolved: PluginSettings = {
    ...DEFAULT_SETTINGS,
    spaceId: SPACE_ID,
    rootNodeToken: "",
    rootPageTitle: "",
    syncMode: "doc",
    folderMode: "nodes",
    state: emptyState(),
    ...settings,
  };
  const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[], debugs: [] as string[] };
  const harness: DocHarness = {
    fake,
    vault,
    engine: new DocSyncEngine({
      app: app as never,
      getSettings: () => resolved,
      saveSettings: async () => {
        harness.saveCount += 1;
        JSON.stringify(resolved.state); // 状态必须可序列化
      },
      auth: { getToken: async () => "fake-token" } as never,
      logger: makeStubLogger(logs) as never,
    }),
    settings: resolved,
    logs,
    saveCount: 0,
  };
  return harness;
}

async function runDocRound(
  h: DocHarness,
  label: string,
  mode: SyncMode = "both",
  allowErrors = false,
): Promise<{ result: RunResult; delta: FakeCounters }> {
  const before = { ...h.fake.counters };
  const errorsBefore = h.logs.errors.length;
  const result = await h.engine.run({ mode, confirm: async () => "all" });
  const after = h.fake.counters;
  const delta = Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key as keyof FakeCounters] - before[key as keyof FakeCounters]]),
  ) as FakeCounters;

  console.log(`\n=== ${label} ===`);
  console.log(`  plan.counts : ${formatCounts(result.plan.counts)}`);
  console.log(`  report      : ${formatCounts(tally(result.report.map((entry) => `${entry.action}${entry.ok ? "" : "(失败)"}`)))}`);
  console.log(
    `  docs 请求   : create=${delta.docsCreate} update=${delta.docsUpdate} fetch=${delta.docsFetch} meta=${delta.meta} task=${delta.docsTaskPoll} nodeCreate=${delta.nodeCreate} move=${delta.move} uploadAll=${delta.uploadAll}`,
  );
  const failed = result.report.filter((entry) => !entry.ok);
  if (failed.length > 0) console.log(`  失败条目    : ${failed.map((entry) => `${entry.relPath}（${entry.message ?? ""}）`).join("; ")}`);
  if (!allowErrors) {
    eq(h.logs.errors.length, errorsBefore, `${label} 的日志里有新的 error：${h.logs.errors.slice(errorsBefore).join(" / ")}`);
  }
  return { result, delta };
}

function nonSkipCount(plan: SyncPlan): number {
  return plan.items.filter((entry) => entry.action !== "skip").length;
}

function docxNodes(fake: FakeFeishu): { nodeToken: string; title: string; parentNodeToken?: string; objToken: string }[] {
  return [...fake.nodes.values()]
    .filter((node) => node.objType === "docx")
    .map((node) => ({ nodeToken: node.nodeToken, title: node.title, parentNodeToken: node.parentNodeToken, objToken: node.objToken }));
}

function docxNodesOf(fake: FakeFeishu, title: string): { nodeToken: string; title: string; parentNodeToken?: string; objToken: string }[] {
  return docxNodes(fake).filter((node) => node.title === title);
}

/** docs_ai 请求记录：创建/更新/取回三类（取回的路径前缀与创建相同，必须按后缀区分）。 */
function createDocRequests(fake: FakeFeishu): { label: string; body: Record<string, unknown> }[] {
  return fake.docsRequests.filter((item) => item.label === "POST /open-apis/docs_ai/v1/documents");
}

function updateDocRequests(fake: FakeFeishu): { label: string; body: Record<string, unknown> }[] {
  return fake.docsRequests.filter((item) => item.label.startsWith("PUT "));
}

async function sha256OfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

// ---------------------------------------------------------------- 场景

const scenarioResults: { name: string; ok: boolean; detail: string }[] = [];
const uncaught: string[] = [];
/** 新模式（留空 rootNodeToken）场景里新建的假服务器，用于最后汇总。 */
const newModeFakes: { label: string; fake: FakeFeishu }[] = [];
/** 文档模式场景里的假服务器，用于最后汇总。 */
const docFakes: { label: string; fake: FakeFeishu }[] = [];
/** 删除传播场景里的 md 模式假服务器，用于最后汇总。 */
const deleteFakes: { label: string; fake: FakeFeishu }[] = [];

async function scenario(name: string, body: () => Promise<string>): Promise<void> {
  try {
    const detail = await body();
    scenarioResults.push({ name, ok: true, detail });
    console.log(`✓ ${name} —— ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scenarioResults.push({ name, ok: false, detail: message });
    console.log(`✗ ${name} —— ${message}`);
  }
}

interface VaultInfo {
  copied: string[];
  emptyFiles: string[];
  nonEmptyFiles: string[];
  directDirs: string[];
  requiredDirs: string[];
}

function dirOf(relPath: string): string {
  return relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
}

/** 重建一份临时 vault 副本（只复制 .md），并算出目录/空文件的预期集合。 */
function prepareVault(root: string): VaultInfo {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const copied: string[] = [];
  copyMarkdownTree(SRC_VAULT, root, copied, root);
  ok(copied.length > 0, `没有从 ${SRC_VAULT} 复制到任何 .md`);
  const emptyFiles = sorted(copied.filter((relPath) => vaultFileSize(relPath, root) === 0));
  const nonEmptyFiles = sorted(copied.filter((relPath) => vaultFileSize(relPath, root) > 0));
  const directDirs = sorted(new Set(nonEmptyFiles.map(dirOf).filter(Boolean)));
  // 需要存在的远端容器节点 = 所有被同步笔记的各级祖先目录（中间层目录即使没有直属笔记也要建）
  const requiredDirs = sorted(
    new Set(
      nonEmptyFiles.flatMap((relPath) => {
        const parts = dirOf(relPath).split("/").filter(Boolean);
        return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
      }),
    ),
  );
  return { copied, emptyFiles, nonEmptyFiles, directDirs, requiredDirs };
}

async function main(): Promise<void> {
  // 1. 重建临时 vault（只复制 .md）
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const { copied, emptyFiles, nonEmptyFiles, directDirs, requiredDirs } = prepareVault(VAULT_ROOT);

  console.log(`vault 源      : ${SRC_VAULT}`);
  console.log(`vault 副本    : ${VAULT_ROOT}`);
  console.log(`笔记总数      : ${copied.length}（非空 ${nonEmptyFiles.length}，0 字节 ${emptyFiles.length}）`);
  console.log(`直属含笔记目录: ${directDirs.length}；需要建的容器节点目录: ${requiredDirs.length}（含中间层）`);

  const fake = new FakeFeishu();
  __setRequestUrlHandler(fake.handler);
  const h = createHarness(fake);

  // ---- 场景 0：转换规则纯函数（不依赖假服务器）
  await scenario("0 转换规则：块级公式独占段落 + 数学环境 # 转义", async () => {
    const rules = defaultRulesFile();
    const ctx: RuleContext = { relPath: "note.md", documentTitle: "note", localContent: "" };
    const toFeishu = (text: string): string => applyRules("toFeishu", text, ctx, rules);

    eq(toFeishu("前文\n$$a=b$$\n后文"), "前文\n\n$$a=b$$\n\n后文", "块级公式前后应各补一个空行");
    eq(toFeishu("讲解 $$a=b$$ 收尾"), "讲解\n\n$$a=b$$\n\n收尾", "公式与正文同行时应拆成独立段落");
    eq(toFeishu("前文\n\n$$\na=b\n$$\n\n后文"), "前文\n\n$$\na=b\n$$\n\n后文", "已经独立成段的公式不应被改写");
    eq(toFeishu("当 $URL = path#fragment$ 时"), "当 $URL = path\\#fragment$ 时", "行内公式里的裸 # 应转义");
    eq(toFeishu("$$URL = path#fragment$$"), "$$URL = path\\#fragment$$", "块级公式里的裸 # 应转义");
    eq(toFeishu("当 $a=\\#b$ 时"), "当 $a=\\#b$ 时", "已转义的 # 不应二次转义");
    eq(toFeishu("```\n$$a#b$$\n```"), "```\n$$a#b$$\n```", "围栏代码块内不应改动");
    eq(toFeishu("行内代码 `$$a#b$$` 保留"), "行内代码 `$$a#b$$` 保留", "行内代码内不应改动");
    eq(toFeishu("- 列表项 $$a=b$$"), "- 列表项 $$a=b$$", "列表项里的公式不拆（保住列表结构）");
    eq(toFeishu("> 引用里的公式 $$a=b$$"), "> 引用里的公式 $$a=b$$", "引用块里的公式不拆（保住引用结构）");
    eq(toFeishu("## 标题里的公式 $$a=b$$"), "## 标题里的公式 $$a=b$$", "标题里的公式不拆（不制造空标题）");
    eq(
      toFeishu(toFeishu("前文\n讲解 $$a#b$$ 收尾")),
      "前文\n讲解\n\n$$a\\#b$$\n\n收尾",
      "规则应幂等：重复应用不再变化",
    );

    // 行内公式内侧空格会让飞书整段当纯文本，$ 都留着不渲染
    eq(toFeishu("当 $ g_a=1 $ 时"), "当 $g_a=1$ 时", "行内公式内侧空格应去掉");
    eq(toFeishu("当 $x>0$ 时"), "当 $x>0$ 时", "句子中间的行内公式不提块");
    eq(toFeishu("$E = mc^2$"), "$$\nE = mc^2\n$$", "独占一行的行内公式应提成块级");
    eq(toFeishu("前文\n$E = mc^2$"), "前文\n\n$$\nE = mc^2\n$$", "提块后前面应补空行");
    eq(toFeishu("$A$和  \n$B$"), "$$\nA\n$$\n\n和\n\n$$\nB\n$$", "尾随连接词应另起一行，两条公式各自成段");
    eq(toFeishu("$E = mc^2$。"), "$E = mc^2$。", "行尾只有标点时不提块（不丢标点）");
    eq(toFeishu("$g_u$拉向："), "$g_u$拉向：", "公式后紧跟正文时整行不动");
    eq(toFeishu("$URL = path#fragment$"), "$$\nURL = path\\#fragment\n$$", "独占一行的行内公式：提块 + 转义");
    eq(toFeishu("- 列表项 $x$"), "- 列表项 $x$", "列表项里的行内公式不提块");
    const promoted = toFeishu("前文\n$ g_a=1 $");
    eq(toFeishu(promoted), promoted, "去空格与提块同样幂等");

    return "公式规则 24 条断言";
  });

  // ---- 场景 1：远端为空
  let round1: RoundResult | undefined;
  await scenario("1 首轮上传（远端为空）", async () => {
    round1 = await runRound(h, "第 1 轮：远端为空", { mode: "both" });

    eq(round1.plan.localNoteCount, copied.length, "本地笔记数");
    eq(round1.plan.remoteNoteCount, 0, "远端笔记数");
    eq(round1.plan.counts["create-remote"] ?? 0, nonEmptyFiles.length, "create-remote 数量");
    eq(round1.plan.counts["empty-local"] ?? 0, emptyFiles.length, "empty-local 数量");
    eq(childItems(round1.plan, "create-remote").join("|"), nonEmptyFiles.join("|"), "create-remote 的 relPath 集合");
    eq(childItems(round1.plan, "empty-local").join("|"), emptyFiles.join("|"), "empty-local 的 relPath 集合");

    eq(round1.delta.uploadAll, nonEmptyFiles.length, "upload_all 调用次数");
    const containerDirs = sorted(
      [...fake.nodes.values()]
        .filter((node) => node.objType === "docx" && node.nodeToken !== ROOT_NODE)
        .map((node) => fake.relPathOfNode(node.nodeToken)),
    );
    eq(containerDirs.join("|"), requiredDirs.join("|"), "容器节点对应的远端目录集合");
    eq(round1.delta.nodeCreate, requiredDirs.length, "容器节点创建数");
    eq(round1.report.filter((entry) => !entry.ok).length, 0, "失败条目数");

    eq(fake.metaRequests.length, 1, "batch_query 请求数");
    eq(fake.metaRequests[0]?.withUrl, true, "batch_query 的 with_url");
    eq(fake.metaRequests[0]?.docTypes.join("|"), "file", "batch_query 的 doc_type");

    assertUploads(round1.uploads, "第 1 轮");
    eq(round1.uploads.length, nonEmptyFiles.length, "本轮上传次数");
    eq(sorted(round1.uploads.map((upload) => upload.relPath ?? "?")).join("|"), nonEmptyFiles.join("|"), "上传落地的远端路径集合");
    eq(fake.fileNodes().length, nonEmptyFiles.length, "远端 file 节点数");
    for (const relPath of emptyFiles) {
      ok(!round1.uploads.some((upload) => upload.relPath === relPath), `0 字节文件被上传了：${relPath}`);
    }

    return `${nonEmptyFiles.length} 篇 create-remote / ${emptyFiles.length} 篇 empty-local / 容器节点 ${requiredDirs.length} 个 / 上传 ${round1.delta.uploadAll} 次`;
  });

  // ---- 场景 2：无改动
  await scenario("2 无改动重跑", async () => {
    const round = await runRound(h, "第 2 轮：无任何改动", { mode: "both" });
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");
    eq(round.delta.nodeCreate, 0, "容器节点创建数");
    for (const action of ["push", "create-remote", "pull", "create-local", "conflict"]) {
      eq(round.plan.counts[action] ?? 0, 0, `${action} 数量`);
    }
    eq(round.plan.counts["empty-local"] ?? 0, emptyFiles.length, "empty-local 数量");
    const skipAndLink = (round.plan.counts.skip ?? 0) + (round.plan.counts.link ?? 0);
    eq(skipAndLink, copied.length - emptyFiles.length, "skip+link 数量");
    eq(round.report.filter((entry) => !entry.ok).length, 0, "失败条目数");
    return `upload_all=${round.delta.uploadAll}，skip=${round.plan.counts.skip ?? 0}，link=${round.plan.counts.link ?? 0}，empty-local=${round.plan.counts["empty-local"] ?? 0}`;
  });

  // ---- 场景 3：本地改一篇 → push
  await scenario("3 本地改一篇（覆盖上传，token 稳定）", async () => {
    const before = h.settings.state.records[PUSH_TARGET];
    ok(before, `第 1 轮后没有 ${PUSH_TARGET} 的基线记录`);
    const tokenBefore = before.fileToken;
    const nodeTokenBefore = fake.fileNodeAt(PUSH_TARGET)?.nodeToken;
    const fileCountBefore = fake.fileNodes().length;

    const newText = `${readVaultFile(PUSH_TARGET)}\n\n## 本地改动（E2E 场景 3）\n这一行只在本地出现，用来触发 push。\n`;
    writeVaultFile(PUSH_TARGET, newText);

    const round = await runRound(h, "第 3 轮：本地改一篇", { mode: "both" });
    eq(round.delta.uploadAll, 1, "upload_all 调用次数");
    eq(round.plan.counts.push ?? 0, 1, "push 数量");
    eq(childItems(round.plan, "push")[0], PUSH_TARGET, "push 的 relPath");
    for (const action of ["pull", "conflict", "create-remote", "create-local"]) eq(round.plan.counts[action] ?? 0, 0, `${action} 数量`);

    assertUploads(round.uploads, "第 3 轮");
    eq(round.uploads.length, 1, "本轮上传次数");
    eq(round.uploads[0]?.fileToken, tokenBefore, "覆盖上传带的 file_token（必须复用旧 token）");

    const recordAfter = h.settings.state.records[PUSH_TARGET];
    ok(recordAfter, "push 后没有更新基线记录");
    eq(recordAfter.fileToken, tokenBefore, "覆盖前后 file_token（分享链接依赖它的稳定性）");
    eq(fake.fileTokenAt(PUSH_TARGET), tokenBefore, "远端 file_token");
    eq(fake.fileNodeAt(PUSH_TARGET)?.nodeToken, nodeTokenBefore, "远端 node_token");
    eq(fake.fileNodes().length, fileCountBefore, "远端 file 节点总数（不能新增重复节点）");
    eq(fake.remoteText(PUSH_TARGET), newText, "远端内容");
    eq(fake.entryAt(PUSH_TARGET)?.version, 2, "远端版本号");

    return `push=${round.plan.counts.push}，upload_all=${round.delta.uploadAll}，file_token 保持 ${tokenBefore}`;
  });

  // ---- 场景 4：远端改一篇 → pull
  await scenario("4 远端改一篇（拉取覆盖本地）", async () => {
    const before = h.settings.state.records[PULL_TARGET];
    ok(before, `第 1 轮后没有 ${PULL_TARGET} 的基线记录`);

    const remoteText = `# 远端改动（E2E 场景 4）\n这行只在飞书那边存在，用来触发 pull。\n${"远端内容".repeat(20)}\n`;
    fake.editRemote(PULL_TARGET, remoteText);

    const round = await runRound(h, "第 4 轮：远端改一篇", { mode: "both" });
    eq(round.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(childItems(round.plan, "pull")[0], PULL_TARGET, "pull 的 relPath");
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");
    for (const action of ["push", "conflict", "create-remote", "create-local"]) eq(round.plan.counts[action] ?? 0, 0, `${action} 数量`);

    eq(readVaultFile(PULL_TARGET), remoteText, "本地内容（应等于远端字节）");
    eq(fake.remoteText(PULL_TARGET), remoteText, "远端内容（pull 不该动远端）");
    eq(h.settings.state.records[PULL_TARGET]?.fileToken, before.fileToken, "拉取后的 file_token");

    return `pull=${round.plan.counts.pull}，本地字节 === 远端字节（${Buffer.byteLength(remoteText)} 字节）`;
  });

  // ---- 场景 5：两边都改 → conflict
  let conflictCopyPath = "";
  await scenario("5 两边都改（冲突：生成副本，两边都不动）", async () => {
    ok(h.settings.state.records[CONFLICT_TARGET], `第 1 轮后没有 ${CONFLICT_TARGET} 的基线记录`);
    const localText = `# 本地版本（E2E 场景 5）\n本地改的内容。\n${"本地".repeat(30)}\n`;
    const remoteText = `# 远端版本（E2E 场景 5）\n飞书那边改的内容。\n${"远端".repeat(45)}\n`;
    writeVaultFile(CONFLICT_TARGET, localText);
    fake.editRemote(CONFLICT_TARGET, remoteText);

    const round = await runRound(h, "第 5 轮：两边都改", { mode: "both" });
    eq(round.plan.counts.conflict ?? 0, 1, "conflict 数量");
    eq(childItems(round.plan, "conflict")[0], CONFLICT_TARGET, "conflict 的 relPath");
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");

    const entries = round.report.filter((entry) => entry.action === "conflict" && entry.ok);
    eq(entries.length, 1, "冲突报告条目数");
    const copyPath = entries[0]?.copyPath;
    ok(copyPath, "冲突报告里没有 copyPath");
    ok(copyPath.startsWith(`${CONFLICT_DIR_REL}/`), `副本路径不在冲突目录里：${copyPath}`);
    ok(fs.existsSync(path.join(VAULT_ROOT, copyPath)), `副本文件不存在：${copyPath}`);
    conflictCopyPath = copyPath;

    eq(fs.readFileSync(path.join(VAULT_ROOT, copyPath), "utf8"), remoteText, "副本内容（应等于远端版本）");
    eq(readVaultFile(CONFLICT_TARGET), localText, "本地内容（应保持本地版本，不能被覆盖）");
    eq(fake.remoteText(CONFLICT_TARGET), remoteText, "远端内容（应保持远端版本，不能被覆盖）");
    eq(listConflictCopies().length, 1, "冲突副本文件数");

    return `conflict=1，副本 ${copyPath}，本地/远端都未被改动`;
  });

  // ---- 场景 6：再跑一轮，冲突仍报告但不新增副本
  await scenario("6 冲突未处理时重跑（不重复生成副本）", async () => {
    ok(conflictCopyPath, "场景 5 没有拿到副本路径");
    const round = await runRound(h, "第 6 轮：不做任何改动", { mode: "both" });
    eq(round.plan.counts.conflict ?? 0, 1, "conflict 数量（应仍被报告）");
    eq(round.plan.counts.skip ?? 0, nonEmptyFiles.length - 1, "skip 数量");
    eq(round.plan.localNoteCount, copied.length, "本地笔记数（冲突副本不能被当成笔记）");
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");

    const entries = round.report.filter((entry) => entry.action === "conflict");
    eq(entries.length, 1, "冲突报告条目数");
    eq(entries[0]?.copyPath, conflictCopyPath, "冲突报告复用的副本路径");
    const copies = listConflictCopies();
    eq(copies.length, 1, "冲突副本文件数（不应新增）");
    eq(path.join(CONFLICT_DIR_REL, copies[0]), conflictCopyPath, "冲突副本文件路径");

    return `conflict=1（复用 ${path.basename(conflictCopyPath)}），upload_all=${round.delta.uploadAll}，副本数=1`;
  });

  // ---- 场景 7：空响应保护
  await scenario("7 远端返回空响应（报错且不覆盖本地）", async () => {
    const localBefore = readVaultFile(EMPTY_DOWNLOAD_TARGET);
    const record = h.settings.state.records[EMPTY_DOWNLOAD_TARGET];
    ok(record, `第 1 轮后没有 ${EMPTY_DOWNLOAD_TARGET} 的基线记录`);
    const token = record.fileToken;

    fake.editRemote(EMPTY_DOWNLOAD_TARGET, `${localBefore}\n远端新增一行，触发 pull，但下载会返回 0 字节。\n`);

    // (a) 计划阶段正常，执行阶段下载返回 200 + 0 字节
    const round = await runRound(h, "第 7 轮 a：执行期下载空响应", {
      mode: "both",
      confirm: async () => {
        fake.emptyDownloadTokens.add(token);
        return "all";
      },
    });
    eq(round.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(childItems(round.plan, "pull")[0], EMPTY_DOWNLOAD_TARGET, "pull 的 relPath");
    const failures = round.report.filter((entry) => !entry.ok);
    eq(failures.length, 1, "失败条目数");
    ok(/空内容/.test(failures[0]?.message ?? ""), `失败原因不是空响应保护：${failures[0]?.message}`);
    eq(readVaultFile(EMPTY_DOWNLOAD_TARGET), localBefore, "本地内容（不能被 0 字节响应覆盖）");
    ok(h.logs.errors.some((line) => /空内容/.test(line)), "logger.error 里没有空响应记录");

    // (b) 计划阶段（按内容校验）下载返回 0 字节 → 整轮直接报错
    let thrown = "";
    try {
      await h.engine.run({ mode: "both", confirm: async () => "all" });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    ok(thrown.length > 0, "计划阶段拿到空响应时应该抛错");
    ok(/空内容/.test(thrown), `抛出的错误不是空响应保护：${thrown}`);
    eq(readVaultFile(EMPTY_DOWNLOAD_TARGET), localBefore, "本地内容（仍然不能被覆盖）");

    fake.emptyDownloadTokens.delete(token);
    return `执行期报错「${failures[0]?.message}」，计划期抛错，本地内容未变`;
  });

  // ---- 场景 8：整体
  await scenario("8 整体检查（无重复节点 / 无未实现端点 / 无未捕获异常）", async () => {
    eq(fake.duplicateTitles.length, 0, "同名节点数");
    eq(fake.unknownRoutes.length, 0, "未实现的端点调用数");
    eq(uncaught.length, 0, "未捕获异常数");
    ok(fake.uploads.every((upload) => upload.parentType === "wiki"), "存在非 wiki 的上传（走了云空间中转兜底）");
    ok(h.saveCount > 0, "saveSettings 没有被调用过");
    return `重复节点 0，未实现端点 0，未捕获异常 0，saveSettings ${h.saveCount} 次`;
  });

  // ---- 场景 9（附加，超出要求的 8 个）：远端新建 → create-local；两边一致 → link
  await scenario("9 附加：远端新建（create-local）+ 两边一致（link）", async () => {
    const remoteOnly = "Others/远端新建目录/子目录/远端新建笔记.md";
    const remoteOnlyText = "# 远端新建（E2E 附加场景）\n这篇只存在于飞书那边。\n";
    fake.addRemoteFile(remoteOnly, remoteOnlyText);

    const bothSides = "Others/两边一致.md";
    const bothSidesText = "# 两边一致（E2E 附加场景）\n内容一模一样。\n";
    fake.addRemoteFile(bothSides, bothSidesText);
    writeVaultFile(bothSides, bothSidesText);

    const round = await runRound(h, "第 9 轮：远端新建两篇", { mode: "both" });
    eq(round.plan.counts["create-local"] ?? 0, 1, "create-local 数量");
    eq(childItems(round.plan, "create-local")[0], remoteOnly, "create-local 的 relPath");
    eq(round.plan.counts.link ?? 0, 1, "link 数量");
    eq(childItems(round.plan, "link")[0], bothSides, "link 的 relPath");
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");
    eq(round.report.filter((entry) => !entry.ok).length, 0, "失败条目数");

    ok(fs.existsSync(path.join(VAULT_ROOT, remoteOnly)), `create-local 没有落地本地文件：${remoteOnly}`);
    eq(readVaultFile(remoteOnly), remoteOnlyText, "新建本地文件的内容");
    ok(h.settings.state.records[remoteOnly], "create-local 后没有写基线记录");
    ok(h.settings.state.records[bothSides], "link 后没有写基线记录");

    // 第 7 轮失败的 pull 也应该在这一轮被重试成功
    eq(round.plan.counts.pull ?? 0, 1, "pull 数量（第 7 轮失败后的重试）");
    eq(childItems(round.plan, "pull")[0], EMPTY_DOWNLOAD_TARGET, "重试 pull 的 relPath");
    eq(readVaultFile(EMPTY_DOWNLOAD_TARGET), fake.remoteText(EMPTY_DOWNLOAD_TARGET), "重试 pull 后的本地内容");

    const next = await runRound(h, "第 10 轮：新增内容已同步", { mode: "both" });
    eq(next.delta.uploadAll, 0, "upload_all 调用次数");
    eq(next.plan.counts.conflict ?? 0, 1, "conflict 数量（未处理的冲突仍在）");
    eq(
      next.plan.counts.skip ?? 0,
      next.plan.localNoteCount - 1 - (next.plan.counts["empty-local"] ?? 0),
      "skip 数量（除冲突文件外的所有非空笔记）",
    );

    eq(fake.duplicateTitles.length, 0, "同名节点数");
    eq(fake.unknownRoutes.length, 0, "未实现的端点调用数");
    eq(uncaught.length, 0, "未捕获异常数");
    return `create-local=1，link=1，失败 pull 重试成功，下一轮 skip=${next.plan.counts.skip} upload_all=0`;
  });

  // ---- 场景 10（附加）：wiki 直传被拒 → 云空间中转兜底
  await scenario("10 附加：wiki 直传失败走云空间中转兜底", async () => {
    const fallbackTarget = "Others/兜底新建.md";
    const fallbackText = "# 兜底新建（E2E 附加场景）\nwiki 直传被拒时应该走 explorer + move_docs_to_wiki。\n";
    writeVaultFile(fallbackTarget, fallbackText);
    fake.rejectWikiUploads = true;
    let round: RoundResult;
    try {
      round = await runRound(h, "第 11 轮：wiki 直传被拒", { mode: "both" }, true);
    } finally {
      fake.rejectWikiUploads = false;
    }

    eq(round.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");
    eq(round.report.filter((entry) => entry.action === "create-remote" && entry.ok).length, 1, "兜底上传的报告条目");
    eq(round.delta.uploadAll, 2, "upload_all 调用次数（1 次失败 + 1 次兜底）");
    eq(round.delta.move, 1, "move_docs_to_wiki 调用次数");
    const explorerUpload = round.uploads.find((upload) => upload.parentType === "explorer");
    ok(explorerUpload, "没有看到 parent_type=explorer 的兜底上传");
    ok(round.uploads.some((upload) => upload.rejected), "没有看到被拒绝的 wiki 直传");
    eq(fake.remoteText(fallbackTarget), fallbackText, "兜底后远端内容");
    ok(h.settings.state.records[fallbackTarget], "兜底后没有写基线记录");

    // 兜底只在"新建"时生效：被拒的直传没有落地，所以不会留下重复节点
    eq(fake.duplicateTitles.length, 0, "同名节点数");
    eq(h.settings.state.records[fallbackTarget]?.fileToken, fake.fileTokenAt(fallbackTarget), "兜底后的 file_token 与远端节点一致");

    const next = await runRound(h, "第 12 轮：兜底之后", { mode: "both" });
    eq(next.delta.uploadAll, 0, "upload_all 调用次数");
    eq(
      next.plan.counts.skip ?? 0,
      next.plan.localNoteCount - 1 - (next.plan.counts["empty-local"] ?? 0),
      "skip 数量（兜底之后基线正常，不会反复重传）",
    );

    return `直传被拒 → explorer 上传 + move_docs_to_wiki 成功，远端内容正确，下一轮 upload_all=0`;
  });

  // ---- 场景 11（附加）：单边删除不会被自动同步（防误删）
  await scenario("11 附加：单边删除不自动同步（不误删另一端）", async () => {
    const localDeletedTarget = "Diary/2026-07-30.md";
    const remoteDeletedTarget = "FudanLab/info/实验室服务器.md";
    ok(fs.existsSync(path.join(VAULT_ROOT, localDeletedTarget)), `本地缺少 ${localDeletedTarget}`);
    ok(fake.fileNodeAt(remoteDeletedTarget), `远端缺少 ${remoteDeletedTarget}`);
    const remoteKept = fake.remoteText(remoteDeletedTarget);
    const localKept = readVaultFile(localDeletedTarget);

    fs.rmSync(path.join(VAULT_ROOT, localDeletedTarget));
    fake.removeRemoteFile(remoteDeletedTarget);

    const round = await runRound(h, "第 13 轮：两边各删了一篇", { mode: "both" });
    eq(round.plan.counts["local-deleted"] ?? 0, 1, "local-deleted 数量");
    eq(childItems(round.plan, "local-deleted")[0], localDeletedTarget, "local-deleted 的 relPath");
    eq(round.plan.counts["remote-deleted"] ?? 0, 1, "remote-deleted 数量");
    eq(childItems(round.plan, "remote-deleted")[0], remoteDeletedTarget, "remote-deleted 的 relPath");
    eq(round.delta.uploadAll, 0, "upload_all 调用次数");
    eq(round.report.filter((entry) => !entry.ok).length, 0, "失败条目数");

    ok(fake.fileNodeAt(localDeletedTarget), `本地删除不该删掉远端：${localDeletedTarget}`);
    eq(fake.remoteText(localDeletedTarget), localKept, "远端内容（本地删除后应保持）");
    ok(fs.existsSync(path.join(VAULT_ROOT, remoteDeletedTarget)), `远端删除不该删掉本地：${remoteDeletedTarget}`);
    eq(readVaultFile(remoteDeletedTarget), remoteKept, "本地内容（远端删除后应保持）");

    return `local-deleted=1（远端保留），remote-deleted=1（本地保留），upload_all=0`;
  });

  // ---- 场景 12：新模式——不指定同步根节点（知识空间顶层即根，一级目录 = 知识库一级页面）
  await scenario("12 新模式：留空 rootNodeToken（一级目录成为知识库一级页面）", async () => {
    const topRoot = path.join(TMP_ROOT, "vault-top");
    const topInfo = prepareVault(topRoot);
    const topFake = new FakeFeishu({ seedRootNode: false }); // 空间顶层初始为空，没有预置根节点
    newModeFakes.push({ label: "场景 12", fake: topFake });
    __setRequestUrlHandler(topFake.handler);
    const th = createHarness(topFake, {
      vaultRoot: topRoot,
      vaultName: VAULT_NAME,
      settings: { rootNodeToken: "", rootPageTitle: "" },
    });

    const rootNotePaths = topInfo.nonEmptyFiles.filter((relPath) => !relPath.includes("/"));
    const firstLevelDirs = topInfo.requiredDirs.filter((dir) => !dir.includes("/"));
    const nestedDirs = topInfo.requiredDirs.filter((dir) => dir.includes("/"));
    const creationOf = (nodeToken: string) => topFake.nodeCreations.find((item) => item.nodeToken === nodeToken);
    const containerAt = (dirPath: string) =>
      [...topFake.nodes.values()].find((node) => node.objType !== "file" && topFake.relPathOfNode(node.nodeToken) === dirPath);
    // 与 walkWikiTree 同口径：根页面这一层不算进路径
    const logicalUploadPaths = (uploads: UploadRecord[]): string[] =>
      sorted(
        uploads.map((upload) => {
          const dir = upload.parentNode ? topFake.relPathOfNode(upload.parentNode) : "";
          return dir ? `${dir}/${upload.fileName}` : upload.fileName;
        }),
      );

    console.log(`\n新模式 vault 副本：${topRoot}（vault 名 = ${VAULT_NAME}，rootNodeToken 留空）`);
    console.log(`  vault 根目录下的非空笔记：${rootNotePaths.join(", ")}`);
    console.log(`  一级目录：${firstLevelDirs.join(", ")}`);

    // ---- 第 14 轮：首轮上传
    const roundA = await runRound(th, "第 14 轮：新模式首轮（远端为空）", { mode: "both" });
    assertUploadsHaveWikiParent(roundA.uploads, "第 14 轮");
    eq(roundA.plan.counts["create-remote"] ?? 0, topInfo.nonEmptyFiles.length, "create-remote 数量");
    eq(roundA.plan.counts["empty-local"] ?? 0, topInfo.emptyFiles.length, "empty-local 数量");
    eq(childItems(roundA.plan, "create-remote").join("|"), topInfo.nonEmptyFiles.join("|"), "create-remote 的 relPath 集合");
    eq(roundA.delta.nodeCreate, topInfo.requiredDirs.length + 1, "容器节点创建数（各级目录 + 1 个根页面）");
    eq(roundA.report.filter((entry) => !entry.ok).length, 0, "失败条目数");

    // 一级目录必须是不带 parent_node_token 的空间一级节点
    const topLevelCreations = topFake.nodeCreations.filter((item) => !item.hasParentField);
    eq(
      sorted(topLevelCreations.map((item) => item.title)).join("|"),
      sorted([...firstLevelDirs, VAULT_NAME]).join("|"),
      "不带 parent_node_token 创建的节点标题集合（一级目录 + 根页面）",
    );
    for (const dir of firstLevelDirs) {
      const node = containerAt(dir);
      ok(node, `没有找到一级目录节点：${dir}`);
      ok(!node.parentNodeToken, `一级目录 ${dir} 的父节点应为空（空间一级），实际 ${String(node.parentNodeToken)}`);
      eq(creationOf(node.nodeToken)?.hasParentField, false, `一级目录 ${dir} 创建时不应带 parent_node_token`);
    }

    // 子目录仍必须带 parent_node_token，挂在对应父目录下
    for (const dir of nestedDirs) {
      const node = containerAt(dir);
      ok(node, `没有找到子目录节点：${dir}`);
      const creation = creationOf(node.nodeToken);
      eq(creation?.hasParentField, true, `子目录 ${dir} 创建时应该带 parent_node_token`);
      const parent = containerAt(dirOf(dir));
      ok(parent, `没有找到 ${dir} 的父目录节点：${dirOf(dir)}`);
      eq(creation?.parentNodeToken, parent.nodeToken, `子目录 ${dir} 的父节点`);
    }

    // 空间顶层额外创建了一个标题为 vault 名的页面，用于放 vault 根目录下的笔记
    const rootPages = topFake.topLevelNodesTitled(VAULT_NAME);
    eq(rootPages.length, 1, `空间顶层标题为 ${VAULT_NAME} 的页面数`);
    const rootPageToken = rootPages[0].nodeToken;
    eq(creationOf(rootPageToken)?.hasParentField, false, "根页面创建时不应带 parent_node_token");
    eq(th.settings.state.folders[""]?.nodeToken, rootPageToken, "state.folders[''] 指向的根页面");
    eq(
      sorted(topFake.childrenOf(rootPageToken).map((node) => node.title)).join("|"),
      sorted(rootNotePaths.map((relPath) => relPath.split("/").pop() as string)).join("|"),
      "根页面下的子节点（应恰好是 vault 根目录下的笔记）",
    );
    topFake.rootContainerNode = rootPageToken; // 之后算路径都按 vault 口径
    for (const relPath of rootNotePaths) {
      const upload = roundA.uploads.find((item) => item.fileName === relPath);
      ok(upload, `没有看到 ${relPath} 的上传`);
      eq(upload.parentNode, rootPageToken, `${relPath} 上传的 parent_node（应等于根页面）`);
    }
    eq(logicalUploadPaths(roundA.uploads).join("|"), topInfo.nonEmptyFiles.join("|"), "上传落地的 vault 路径集合");
    eq(topFake.fileNodes().length, topInfo.nonEmptyFiles.length, "远端 file 节点数");

    // ---- 第 15 轮：什么都不改 → 必须全部 skip（根页面前缀必须被剥掉）
    const roundB = await runRound(th, "第 15 轮：新模式无改动", { mode: "both" });
    eq(roundB.delta.uploadAll, 0, "upload_all 调用次数");
    eq(roundB.delta.nodeCreate, 0, "容器节点创建数");
    for (const action of ["push", "create-remote", "pull", "create-local", "conflict"]) {
      eq(roundB.plan.counts[action] ?? 0, 0, `${action} 数量（根页面前缀若没被剥掉，这里会冒出来）`);
    }
    eq(roundB.plan.counts.skip ?? 0, topInfo.nonEmptyFiles.length, "skip 数量");
    eq(roundB.plan.counts["empty-local"] ?? 0, topInfo.emptyFiles.length, "empty-local 数量");
    eq(
      roundB.delta.nodeList,
      countContainersWithChildren(topFake) + 1,
      "node_list 次数（只有 walk：folders 里已经记着根页面 token 时不做顶层查找）",
    );

    // ---- 第 16 轮：改一篇 vault 根目录下的笔记 → push（覆盖同一个 file_token）
    const pushTarget = "个人心得.md";
    ok(rootNotePaths.includes(pushTarget), `vault 根目录下没有 ${pushTarget}`);
    const tokenBefore = th.settings.state.records[pushTarget]?.fileToken;
    ok(tokenBefore, `第 14 轮后没有 ${pushTarget} 的基线记录`);
    const nodeTokenBefore = topFake.fileNodeAt(pushTarget)?.nodeToken;
    const fileCountBefore = topFake.fileNodes().length;
    const pushedText = `${readVaultFile(pushTarget, topRoot)}\n\n## 本地改动（场景 12）\n根目录笔记的新内容。\n`;
    writeVaultFile(pushTarget, pushedText, topRoot);

    const roundC = await runRound(th, "第 16 轮：改一篇 vault 根目录笔记", { mode: "both" });
    assertUploadsHaveWikiParent(roundC.uploads, "第 16 轮");
    eq(roundC.plan.counts.push ?? 0, 1, "push 数量");
    eq(childItems(roundC.plan, "push")[0], pushTarget, "push 的 relPath");
    eq(roundC.delta.uploadAll, 1, "upload_all 调用次数");
    eq(roundC.delta.nodeCreate, 0, "容器节点创建数（根页面不该被重建）");
    eq(roundC.uploads.length, 1, "本轮上传次数");
    eq(roundC.uploads[0]?.fileToken, tokenBefore, "覆盖上传带的 file_token");
    eq(roundC.uploads[0]?.parentNode, rootPageToken, "push 的 parent_node（仍应是根页面）");
    eq(th.settings.state.records[pushTarget]?.fileToken, tokenBefore, "覆盖前后 file_token");
    eq(topFake.fileNodeAt(pushTarget)?.nodeToken, nodeTokenBefore, "远端 node_token");
    eq(topFake.fileNodes().length, fileCountBefore, "远端 file 节点总数（不能新增重复节点）");
    eq(topFake.remoteText(pushTarget), pushedText, "远端内容");
    eq(topFake.topLevelNodesTitled(VAULT_NAME).length, 1, `空间顶层标题为 ${VAULT_NAME} 的页面数`);

    // ---- 第 17 轮：回到全 skip
    const roundD = await runRound(th, "第 17 轮：无改动", { mode: "both" });
    eq(roundD.delta.uploadAll, 0, "upload_all 调用次数");
    eq(roundD.plan.counts.skip ?? 0, topInfo.nonEmptyFiles.length, "skip 数量");

    // ---- 第 18 轮：远端直接在空间顶层新增一篇 .md（不经任何页面）→ create-local 到 vault 根目录
    const topLevelNote = "空间顶层新笔记.md";
    const topLevelNoteText = "# 空间顶层新笔记（场景 12）\n模拟知识库里本来就有的顶层 .md。\n";
    topFake.addRemoteFile(topLevelNote, topLevelNoteText);
    const roundE = await runRound(th, "第 18 轮：空间顶层多了一篇 .md", { mode: "both" });
    eq(roundE.plan.counts["create-local"] ?? 0, 1, "create-local 数量");
    eq(childItems(roundE.plan, "create-local")[0], topLevelNote, "create-local 的 relPath（应落在 vault 根目录）");
    eq(roundE.delta.uploadAll, 0, "upload_all 调用次数");
    ok(fs.existsSync(path.join(topRoot, topLevelNote)), `没有落地到 vault 根目录：${topLevelNote}`);
    eq(readVaultFile(topLevelNote, topRoot), topLevelNoteText, "新建本地文件的内容");
    ok(th.settings.state.records[topLevelNote], "create-local 后没有写基线记录");
    eq(topFake.childrenOf(undefined).filter((node) => node.objType === "file").length, 1, "空间顶层的 .md 文件数");

    const roundF = await runRound(th, "第 19 轮：无改动", { mode: "both" });
    eq(roundF.delta.uploadAll, 0, "upload_all 调用次数");
    eq(roundF.plan.counts.skip ?? 0, topInfo.nonEmptyFiles.length + 1, "skip 数量（含刚拉下来的那篇）");

    // ---- 第 20 轮：清空 state.folders（保留 records）后再同步 → 必须按标题复用已存在的根页面
    const newRootNote = "新增根笔记.md";
    writeVaultFile(newRootNote, "# 新增根笔记（场景 12）\n用来逼 ensureRootContainer 跑一次。\n", topRoot);
    th.settings.state.folders = {};
    const roundG = await runRound(th, "第 20 轮：清空 state.folders 后再同步", { mode: "both" });
    assertUploadsHaveWikiParent(roundG.uploads, "第 20 轮");
    eq(roundG.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");
    eq(childItems(roundG.plan, "create-remote")[0], newRootNote, "create-remote 的 relPath");
    eq(roundG.delta.nodeCreate, 0, "容器节点创建数（根页面应按标题复用，不能新建）");
    eq(topFake.topLevelNodesTitled(VAULT_NAME).length, 1, `空间顶层标题为 ${VAULT_NAME} 的页面数（不能出现第二个）`);
    eq(topFake.topLevelNodesTitled(VAULT_NAME)[0]?.nodeToken, rootPageToken, "被复用的根页面 node_token");
    eq(th.settings.state.folders[""]?.nodeToken, rootPageToken, "复用后 state.folders[''] 指向的节点");
    eq(roundG.uploads[0]?.parentNode, rootPageToken, "新增根笔记的 parent_node（复用出来的根页面）");
    eq(topFake.remoteText(newRootNote), readVaultFile(newRootNote, topRoot), "新增根笔记的远端内容");

    // 修复后：读取侧会先按标题认出已有的根页面，所以本轮根目录笔记的远端路径能正常还原
    eq(roundG.plan.counts["remote-deleted"] ?? 0, 0, "remote-deleted 数量（根页面应被识别，不能算成远端已删除）");
    eq(roundG.plan.counts["create-local"] ?? 0, 0, `create-local 数量（不该往本地写出 ${VAULT_NAME}/ 副本）`);
    eq(roundG.plan.counts.skip ?? 0, topInfo.nonEmptyFiles.length + 1, "skip 数量（其余笔记都该按 vault 路径对上；+1 = 第 18 轮拉下来的顶层笔记）");
    eq(roundG.plan.counts["empty-local"] ?? 0, topInfo.emptyFiles.length, "empty-local 数量");
    eq(
      roundG.delta.nodeList,
      countContainersWithChildren(topFake) + 2,
      "node_list 次数（walk + 1 次读取侧顶层查找）",
    );
    ok(!fs.existsSync(path.join(topRoot, VAULT_NAME, "AI API & GPU.md")), `不该往本地写出 ${VAULT_NAME}/ 副本`);
    eq(topFake.duplicateTitles.length, 0, "场景 12 的同名节点数");

    return `首轮 ${topInfo.nonEmptyFiles.length} 篇 create-remote（一级目录 ${firstLevelDirs.length} 个 + 根页面「${VAULT_NAME}」均不带 parent 创建）；无改动轮 upload_all=0 / 全 skip；根目录笔记 push 后 token 不变；顶层 .md 拉回 vault 根目录；清空 folders 后按标题复用根页面（nodeCreate=0、顶层「${VAULT_NAME}」仍只有 1 个、remote-deleted/create-local 均为 0）`;
  });

  // ---- 场景 13：新模式 + 清空"全部"同步状态（= 设置页「清空同步状态」按钮）后重新对齐
  // 这里曾经是 bug：walkWikiTree 的 rootContainerNode 只来自 state.folders[""]，状态被清空
  // （或换机器/新装插件指向同一个已存在的知识库）后认不出顶层根页面，根目录笔记的远端路径被算成
  // "<根页面标题>/xxx.md"，于是同一篇笔记在知识库和 vault 里各多出一份。
  // src 已在 walk 之前补了读取侧的按标题查找，下面是修复后的回归断言。
  const KNOWN_ROOT_PAGE_STATE_LOSS_BUG = false;
  await scenario("13 新模式：清空全部同步状态后重跑（重新对齐，不产生重复）", async () => {
    const clearRoot = path.join(TMP_ROOT, "vault-clearstate");
    const clearInfo = prepareVault(clearRoot);
    const clearFake = new FakeFeishu({ seedRootNode: false });
    newModeFakes.push({ label: "场景 13", fake: clearFake });
    __setRequestUrlHandler(clearFake.handler);
    const ch = createHarness(clearFake, {
      vaultRoot: clearRoot,
      vaultName: VAULT_NAME,
      settings: { rootNodeToken: "", rootPageTitle: "" },
    });
    const rootNotePaths = clearInfo.nonEmptyFiles.filter((relPath) => !relPath.includes("/"));

    const first = await runRound(ch, "第 21 轮：新模式首轮（远端为空）", { mode: "both" });
    eq(first.plan.counts["create-remote"] ?? 0, clearInfo.nonEmptyFiles.length, "create-remote 数量");
    const rootPageToken = ch.settings.state.folders[""]?.nodeToken;
    ok(rootPageToken, "首轮没有建出根页面");
    clearFake.rootContainerNode = rootPageToken;
    const duplicateBefore = clearFake.duplicateTitles.length;

    // 等价于设置页里的「清空同步状态」按钮
    ch.settings.state.records = {};
    ch.settings.state.folders = {};
    ch.settings.state.conflicts = {};

    const infosBefore = ch.logs.infos.length;
    const afterClear = await runRound(ch, "第 22 轮：清空全部同步状态后重跑", { mode: "both" });
    const newDuplicates = clearFake.duplicateTitles.slice(duplicateBefore);
    const duplicatedTitles = sorted(newDuplicates.map((item) => item.title));
    const localGhosts = rootNotePaths.filter((relPath) => fs.existsSync(path.join(clearRoot, VAULT_NAME, relPath)));

    console.log(`  清空状态后：create-remote=${afterClear.plan.counts["create-remote"] ?? 0}，create-local=${afterClear.plan.counts["create-local"] ?? 0}，link=${afterClear.plan.counts.link ?? 0}`);
    console.log(`  请求增量：nodeList=${afterClear.delta.nodeList}（walk ${countContainersWithChildren(clearFake) + 1} 次 + 读取侧顶层查找 1 次），uploadAll=${afterClear.delta.uploadAll}，nodeByToken=${afterClear.delta.nodeByToken}，download=${afterClear.delta.download}`);
    console.log(`  知识库里新增的同名 file 节点：${duplicatedTitles.join(", ") || "（无）"}`);
    console.log(`  vault 里被多写出来的 ${VAULT_NAME}/ 副本：${localGhosts.join(", ") || "（无）"}`);

    if (KNOWN_ROOT_PAGE_STATE_LOSS_BUG) {
      eq(newDuplicates.length, rootNotePaths.length, "新产生的同名 file 节点数（已知 bug，内容相同的笔记被重复上传）");
      eq(duplicatedTitles.join("|"), sorted(rootNotePaths).join("|"), "重复节点的标题（全部是 vault 根目录下的笔记）");
      eq(localGhosts.length, rootNotePaths.length, `本地被多写出来的 ${VAULT_NAME}/ 副本数（已知 bug）`);
      eq(afterClear.plan.counts.link ?? 0, clearInfo.nonEmptyFiles.length - rootNotePaths.length, "link 数量（目录里的笔记路径没变，正常对上）");
    } else {
      // 修复后：根目录笔记与目录笔记都应该按内容对上并只更新基线
      eq(newDuplicates.length, 0, "不应出现任何同名 file 节点");
      eq(localGhosts.length, 0, `不应往本地写出 ${VAULT_NAME}/ 副本`);
      eq(afterClear.plan.counts["create-remote"] ?? 0, 0, "create-remote 数量（不该重新上传）");
      eq(afterClear.plan.counts["create-local"] ?? 0, 0, "create-local 数量");
      eq(afterClear.plan.counts.link ?? 0, clearInfo.nonEmptyFiles.length, "内容相同的笔记应该全部 link");
      eq(afterClear.plan.counts["empty-local"] ?? 0, clearInfo.emptyFiles.length, "empty-local 数量");
      eq(afterClear.report.filter((entry) => !entry.ok).length, 0, "失败条目数");
      eq(afterClear.delta.uploadAll, 0, "upload_all 调用次数（不应重复上传）");
      eq(afterClear.delta.nodeByToken, 0, "node_by_token 调用次数（没有上传就不该查节点）");
      eq(afterClear.delta.nodeCreate, 0, "容器节点创建数");
      eq(clearFake.topLevelNodesTitled(VAULT_NAME).length, 1, `空间顶层标题为 ${VAULT_NAME} 的页面数`);
      eq(clearFake.fileNodes().length, clearInfo.nonEmptyFiles.length, "远端 file 节点数（不该多出来）");
      eq(clearFake.rootContainerNode && ch.settings.state.folders[""]?.nodeToken, rootPageToken, "重新认出的根页面 node_token");
      ok(
        ch.logs.infos.slice(infosBefore).some((line) => line.includes("识别到已有的知识库顶层页面")),
        `没有看到读取侧按标题识别根页面的日志：${ch.logs.infos.slice(infosBefore).join(" / ") || "（无）"}`,
      );
      eq(
        afterClear.delta.nodeList,
        countContainersWithChildren(clearFake) + 2,
        "node_list 次数（walk + 1 次读取侧顶层查找）",
      );
    }

    return KNOWN_ROOT_PAGE_STATE_LOSS_BUG
      ? `已知 bug：清空状态后 create-remote=${afterClear.plan.counts["create-remote"] ?? 0}、create-local=${afterClear.plan.counts["create-local"] ?? 0}，知识库多出 ${newDuplicates.length} 个同名节点，本地多出 ${localGhosts.length} 份 ${VAULT_NAME}/ 副本`
      : `清空状态后重新对齐：link=${afterClear.plan.counts.link ?? 0}，create-remote/create-local=0，重复节点 0，本地副本 0，upload_all=0`;
  });

  // ---- 场景 14：Markdown 往返转换实测（docs_ai）
  await scenario("14 往返转换实测：docs_ai 建文档 → 移入知识库 → fetch → overwrite → fetch → 报告", async () => {
    const missingNeedles = SYNTAX_CHECKS.filter((check) => !SYNTAX_SAMPLE.includes(check.needle)).map((check) => check.label);
    eq(missingNeedles.join("|"), "", "语法样本里缺少核对表用的原文");

    const probeRoot = path.join(TMP_ROOT, "vault-probe");
    fs.rmSync(probeRoot, { recursive: true, force: true });
    fs.mkdirSync(probeRoot, { recursive: true });
    const sampleRel = "往返测试样本.md";
    const sampleText = "# 笔记标题\n\n这是一篇用于往返测试的真实笔记样本。\n\n- 已有双链：[[已有笔记]]\n- 已有标签：#已有标签\n";
    fs.writeFileSync(path.join(probeRoot, sampleRel), sampleText, "utf8");
    const reportPath = path.join(probeRoot, ROUNDTRIP_REPORT_PATH);

    const runProbe = async (fake: FakeFeishu, label: string): Promise<{ logs: Harness["logs"]; report: string }> => {
      __setRequestUrlHandler(fake.handler);
      const vault = new FakeVault(probeRoot);
      const app = {
        vault,
        workspace: { getActiveFile: () => vault.getAbstractFileByPath(sampleRel), getLeavesOfType: () => [] },
      };
      const logs = { infos: [] as string[], warns: [] as string[], errors: [] as string[], debugs: [] as string[] };
      await runRoundtripProbe({
        app: app as never,
        getSettings: () => ({ ...DEFAULT_SETTINGS, appId: "cli_probe", appSecret: "secret", spaceId: SPACE_ID }),
        auth: { getToken: async () => "fake-token" } as never,
        logger: makeStubLogger(logs) as never,
      });
      eq(logs.errors.length, 0, `${label} 的日志里有 error：${logs.errors.join(" / ")}`);
      ok(fs.existsSync(reportPath), `${label} 没有写出报告：${reportPath}`);
      return { logs, report: fs.readFileSync(reportPath, "utf8") };
    };

    // ---- 第一次：创建走异步任务（task_id 轮询）+ 取回有损失
    const fakeA = new FakeFeishu();
    fakeA.docsCreateAsync = true;
    fakeA.docsFidelityLoss = true;
    const first = await runProbe(fakeA, "异步创建那一次");

    eq(fakeA.counters.docsCreate, 1, "创建文档次数");
    ok(fakeA.counters.docsTaskPoll >= 2, `异步任务轮询次数应该 >= 2，实际 ${fakeA.counters.docsTaskPoll}`);
    eq(fakeA.documents.size, 1, "假服务器里的文档数");
    const documentId = [...fakeA.documents.keys()][0] ?? "";

    const createRequest = fakeA.docsRequests.find((item) => item.label === "POST /open-apis/docs_ai/v1/documents");
    ok(createRequest, "没有记录到创建文档请求");
    const createBody = createRequest.body as { format?: string; content?: string; extra_param?: string; parent_token?: string };
    eq(createBody.format, "markdown", "创建请求的 format");
    eq(createBody.extra_param, '{"open_create_async":true}', "创建请求的 extra_param（必须是 JSON 字符串）");
    eq(createBody.parent_token, undefined, "创建请求不该带 parent_token（文档随后靠 move 进知识库）");
    const sentContent = String(createBody.content ?? "");
    ok(sentContent.startsWith("<title>同步往返测试 "), `创建请求的 content 不是以 <title> 开头：${sentContent.slice(0, 40)}`);
    ok(sentContent.includes("# 笔记标题"), "创建请求的 content 里没有笔记原文");
    ok(sentContent.endsWith(SYNTAX_SAMPLE), "创建请求的 content 末尾不是语法样本");
    eq(
      sentContent,
      buildMarkdownContent(docTitleOf(sentContent), appendSyntaxSample(sampleText)),
      "发给飞书的 content 应该是 <title> + 笔记原文 + 语法样本",
    );

    const fetchRequests = fakeA.docsRequests.filter((item) => item.label.endsWith("/fetch"));
    eq(fetchRequests.length, 2, "fetch 调用次数");
    const fetchBody = fetchRequests[0].body as { format?: string; extra_param?: string; export_option?: unknown };
    eq(fetchBody.format, "markdown", "fetch 请求的 format");
    eq(
      fetchBody.extra_param,
      '{"enable_user_cite_reference_map":true,"include_comments":true,"return_html5_block_data":true}',
      "fetch 请求的 extra_param",
    );
    eq(
      JSON.stringify(fetchBody.export_option),
      '{"export_block_id":false,"export_style_attrs":false,"export_cite_extra_data":false}',
      "fetch 请求的 export_option",
    );

    const updateRequest = fakeA.docsRequests.find((item) => item.label.startsWith("PUT "));
    ok(updateRequest, "没有记录到更新请求（更新必须是 PUT）");
    eq(updateRequest.label, `PUT /open-apis/docs_ai/v1/documents/${documentId}`, "更新请求的路径");
    const updateBody = updateRequest.body as { format?: string; command?: string; revision_id?: number; content?: string };
    eq(updateBody.format, "markdown", "更新请求的 format");
    eq(updateBody.command, "overwrite", "更新请求的 command");
    eq(updateBody.revision_id, -1, "更新请求的 revision_id");
    eq(updateBody.content, sentContent, "更新请求的 content 必须与创建时完全一致");

    eq(fakeA.counters.move, 1, "move_docs_to_wiki 调用次数");
    const moveRequest = fakeA.moveRequests[0];
    eq(moveRequest?.objType, "docx", "move_docs_to_wiki 的 obj_type");
    eq(moveRequest?.objToken, documentId, "move_docs_to_wiki 的 obj_token");
    eq(moveRequest?.apply, true, "move_docs_to_wiki 的 apply");
    const documentNode = [...fakeA.nodes.values()].find((node) => node.objToken === documentId && node.objType === "docx");
    ok(documentNode, "文档没有被移进知识库");
    eq(moveRequest?.parentWikiToken, documentNode.parentNodeToken, "move_docs_to_wiki 的 parent_wiki_token");
    const containerNode = documentNode.parentNodeToken ? fakeA.nodes.get(documentNode.parentNodeToken) : undefined;
    ok(containerNode, "找不到容器页面");
    ok(containerNode.title.startsWith("同步往返测试 "), `容器页面标题不对：${containerNode.title}`);
    eq(containerNode.parentNodeToken, undefined, "容器页面应该在知识空间顶层");
    eq(fakeA.unknownRoutes.join("|"), "", "出现了未实现的端点");

    // ---- 报告内容
    const report = first.report;
    for (const heading of ["## ① 原始本地内容", "## ② 实际发给飞书的 content", "## ③ 第一次取回", "## ④ 第二次取回"]) {
      ok(report.includes(heading), `报告缺少段落：${heading}`);
    }
    ok(report.includes(appendSyntaxSample(sampleText)), "报告里没有原始本地内容");
    ok(report.includes(sentContent), "报告里没有实际发给飞书的 content");
    const sentHash = await sha256Hex(new TextEncoder().encode(sentContent).buffer as ArrayBuffer);
    ok(report.includes(sentHash), `报告里没有 content 的 sha256（${sentHash}）`);
    ok(report.includes(`document_id：\`${documentId}\``), "报告里没有 document_id");
    ok(report.includes("样本笔记原文"), "报告里没有样本笔记原文的指纹");
    const noteHash = await sha256Hex(new TextEncoder().encode(sampleText).buffer as ArrayBuffer);
    ok(report.includes(noteHash), `报告里没有笔记原文的 sha256（${noteHash}）`);
    eq(readVaultFile(sampleRel, probeRoot), sampleText, "往返测试不能改动样本笔记");
    ok(report.includes(containerNode.nodeToken), "报告里没有容器页面 node_token");
    ok(report.includes(`https://<你的飞书域名>/wiki/${documentNode.nodeToken}`), "报告里没有知识库节点链接");

    ok(reportRow(report, "待办（未完成）").includes("❌ 未找到"), `待办丢了勾选框却判成保留：${reportRow(report, "待办（未完成）")}`);
    ok(reportRow(report, "callout").includes("❌ 未找到"), "callout 标记被丢掉却判成保留");
    ok(reportRow(report, "frontmatter 块").includes("❌ 未找到"), "frontmatter 块被丢掉却判成保留");
    ok(reportRow(report, "图片（Wiki 嵌入）").includes("❌ 未找到"), "Wiki 嵌入图片被改写却判成保留");
    for (const label of [
      "待办（已完成）",
      "多级列表（第四级）",
      "加粗 / 斜体 / 删除线",
      "行内公式",
      "块级公式",
      "表格",
      "代码块（js）",
      "mermaid 代码块",
      "双链",
      "标签",
      "图片（标准 Markdown）",
      "脚注",
    ]) {
      ok(reportRow(report, label).includes("✅ 第"), `${label} 应该判为逐字保留：${reportRow(report, label)}`);
    }
    const keptRows = SYNTAX_CHECKS.filter((check) => reportRow(report, check.label).includes("✅")).length;
    const lostRows = SYNTAX_CHECKS.filter((check) => reportRow(report, check.label).includes("❌")).length;
    eq(keptRows + lostRows, SYNTAX_CHECKS.length, "每条语法都要有判定结果");

    const firstDiff = sectionOf(report, "## 逐行差异摘要");
    ok(firstDiff.includes("- [ ] 待办：确认这一行是否原样回来"), "差异里没有列出被改写的待办行");
    ok(firstDiff.includes("> [!note] 提示"), "差异里没有列出被丢掉的 callout 标记");
    ok(!firstDiff.includes("[[往返测试目标笔记]]"), "双链没丢，不该出现在差异里");
    ok(firstDiff.includes("只有右侧有的行"), "应该标出只属飞书侧的行");
    ok(firstDiff.includes("两侧行内容一致（按行多重集比较，忽略顺序）"), "③→④ 完全一致时应该给出「一致」结论");
    ok(report.includes("③ 与 ④ 逐字节一致（更新路径稳定）"), "应该判出更新路径稳定");
    ok(report.includes("② 与 ③ 不一致（转换有损失，差异见上）"), "应该判出转换有损失");

    // ---- 第二次：同步创建 + 第二次取回漂移
    const fakeB = new FakeFeishu();
    fakeB.docsCreateAsync = false;
    fakeB.docsFidelityLoss = false;
    fakeB.docsDriftOnSecondFetch = true;
    const second = await runProbe(fakeB, "同步创建那一次");

    eq(fakeB.counters.docsCreate, 1, "创建文档次数");
    eq(fakeB.counters.docsTaskPoll, 0, "同步创建路径不该轮询异步任务");
    eq(fakeB.counters.docsFetch, 2, "fetch 调用次数");
    ok(second.report.includes("② 与 ③ 逐字节一致（这一趟没有任何损失）"), "无损时应该判出逐字节一致");
    ok(second.report.includes("③ 与 ④ 不一致（更新后再取回的内容有变化）"), "应该判出第二次取回与第一次不一致");
    const secondDiff = sectionOf(second.report, "## 逐行差异摘要");
    ok(secondDiff.includes("服务端第二次取回漂移"), "差异里没有列出第二次取回多出来的行");
    ok(
      SYNTAX_CHECKS.every((check) => reportRow(second.report, check.label).includes("✅")),
      "无损那一次应该每条语法都判 ✅",
    );

    console.log(`  异步创建轮询 ${fakeA.counters.docsTaskPoll} 次；核对结果 ✅${keptRows} / ❌${lostRows}`);
    console.log(`  报告：${reportPath}`);
    return `异步建文档轮询 ${fakeA.counters.docsTaskPoll} 次、语法核对 ✅${keptRows}/❌${lostRows}；同步创建 + 取回漂移那一次也按预期判出不一致`;
  });

  // ---- 场景 15~20：文档模式（同一份假 vault 与假服务器，从空远端开始）
  const docRoot = path.join(TMP_ROOT, "vault-doc");
  const docFiles: Record<string, string> = {
    "根笔记.md": "根笔记的正文。\n",
    "Notes/A.md": "A 的正文。\n",
    "Notes/B.md": "B 的正文，带一张图 ![[attachments/pic.png]]。\n",
    "Notes/Sub/C.md": "C 的正文。\n",
  };
  writeDocVault(docRoot, docFiles);
  const docFake = new FakeFeishu({ seedRootNode: false });
  __setRequestUrlHandler(docFake.handler);
  const dh = createDocHarness(docFake, docRoot);
  const docPaths = Object.keys(docFiles).sort();
  const vaultPageTitle = path.basename(docRoot);

  await scenario("15 文档模式：首轮空远端（笔记→文档，目录→容器）", async () => {
    const { result, delta } = await runDocRound(dh, "文档模式第 1 轮：远端为空");

    eq(result.plan.counts["create-remote"] ?? 0, docPaths.length, "create-remote 数量");
    eq(nonSkipCount(result.plan), docPaths.length, "除新建外不该有别的计划项");
    eq(delta.docsCreate, docPaths.length, "创建文档次数");
    eq(delta.docsUpdate, 0, "首轮不该有 PUT");
    eq(delta.move, docPaths.length, "每篇新建后都要 move 进知识库");
    eq(delta.docsFetch, docPaths.length, "每篇新建后都要立刻取回记远端基线");
    ok(delta.docsTaskPoll >= docPaths.length, `异步任务轮询次数应 >= ${docPaths.length}，实际 ${delta.docsTaskPoll}`);
    eq(delta.uploadAll, 0, "文档模式不该上传 md 文件");
    eq(docFake.unknownRoutes.join("|"), "", "文档模式出现了未实现的端点");

    const createBodies = createDocRequests(docFake);
    eq(createBodies.length, docPaths.length, "创建请求数");
    const rootBody = createBodies.find((item) => String(item.body.content).includes("根笔记的正文。"));
    ok(rootBody, "没有找到根笔记的创建请求");
    eq(rootBody.body.format, "markdown", "创建请求的 format");
    eq(rootBody.body.extra_param, '{"open_create_async":true}', "创建请求的 extra_param");
    eq(rootBody.body.parent_token, undefined, "创建请求不该带 parent_token");
    eq(String(rootBody.body.content), "<title>根笔记</title>\n根笔记的正文。\n", "发给飞书的 content 形状");

    for (const move of docFake.moveRequests) {
      eq(move.objType, "docx", "move_docs_to_wiki 的 obj_type");
      eq(move.apply, true, "move_docs_to_wiki 的 apply");
    }

    const containers = docFake.nodeCreations.map((item) => item.title).sort();
    eq(containers.join("|"), [vaultPageTitle, "Notes", "Sub"].sort().join("|"), "容器页面标题");
    const rootPage = docFake.nodeCreations.find((item) => item.title === vaultPageTitle);
    eq(rootPage?.hasParentField, false, "存放根目录笔记的页面应该在知识空间顶层");
    const notesContainer = docFake.nodeCreations.find((item) => item.title === "Notes");
    const subContainer = docFake.nodeCreations.find((item) => item.title === "Sub");
    eq(subContainer?.parentNodeToken, notesContainer?.nodeToken, "Sub 应该挂在 Notes 下");

    const nodes = docxNodes(docFake);
    eq(nodes.length, docPaths.length + 3, "远端 docx 节点数 = 文档 + 容器");
    const titles = nodes.map((node) => node.title).sort();
    eq(titles.join("|"), ["A", "B", "C", "根笔记", "Notes", "Sub", vaultPageTitle].sort().join("|"), "远端节点标题");
    const nodeC = nodes.find((node) => node.title === "C");
    eq(nodeC?.parentNodeToken, subContainer?.nodeToken, "C 应该挂在 Sub 下");

    const recordA = dh.settings.state.docRecords["Notes/A.md"];
    ok(recordA, "没有记下 A 的映射");
    eq(recordA.baseRemoteHash, await sha256OfText("# A\nA 的正文。\n"), "远端基线必须是取回形态的哈希");
    ok(recordA.baseRemoteHash !== (await sha256OfText("<title>A</title>\nA 的正文。\n")), "远端基线不能记发送形态");
    eq(recordA.documentId, nodes.find((node) => node.title === "A")?.objToken, "documentId 应该指向远端文档节点");

    return `${docPaths.length} 篇笔记建了 ${docPaths.length} 篇文档、${docFake.nodeCreations.length} 个容器页面，全部 move 到位（obj_type=docx）`;
  });

  await scenario("16 文档模式：无改动重跑（0 次写请求，全部 skip）", async () => {
    const { result, delta } = await runDocRound(dh, "文档模式第 2 轮：没有任何改动");

    eq(result.plan.counts.skip ?? 0, docPaths.length, "全部 skip");
    eq(nonSkipCount(result.plan), 0, "不该有计划项");
    eq(delta.docsCreate + delta.docsUpdate, 0, "0 次写请求");
    eq(delta.move + delta.nodeCreate, 0, "不该动知识库结构");
    eq(delta.docsFetch, 0, "快路径生效：没改动就不该逐篇取回");
    eq(delta.meta, 1, "改用一次批量元数据请求判断远端是否变更");
    eq(result.report.filter((entry) => !entry.ok).length, 0, "失败条目数");
    eq(docxNodes(docFake).length, docPaths.length + 3, "远端节点数不该变");

    return `全 skip=${result.plan.counts.skip}，create/update=0、move=0、nodeCreate=0，fetch=${delta.docsFetch}（元数据快路径，双基线不震荡）`;
  });

  await scenario("17 文档模式：本地改一篇 → 恰好 1 次 PUT（原位更新）", async () => {
    const relPath = "Notes/A.md";
    const before = dh.settings.state.docRecords[relPath];
    ok(before, "缺少 A 的映射");
    writeVaultFile(relPath, `${readVaultFile(relPath, docRoot)}本地新增的一行。\n`, docRoot);

    const { result, delta } = await runDocRound(dh, "文档模式第 3 轮：本地改一篇");

    eq(result.plan.counts.push ?? 0, 1, "push 数量");
    eq(result.plan.counts.skip ?? 0, docPaths.length - 1, "其余跳过");
    eq(delta.docsUpdate, 1, "PUT 次数");
    eq(delta.docsCreate, 0, "不该新建文档");
    eq(delta.move, 0, "不该再 move");
    eq(delta.docsFetch >= 1 ? 1 : 0, 1, "更新后要取回记新基线");

    const updateRequest = updateDocRequests(docFake).at(-1);
    ok(updateRequest, "没有记录到更新请求");
    eq(updateRequest.label, `PUT /open-apis/docs_ai/v1/documents/${before.documentId}`, "更新请求的路径必须是原文档");
    eq(updateRequest.body.command, "overwrite", "更新命令");
    eq(updateRequest.body.format, "markdown", "更新 format");
    eq(updateRequest.body.revision_id, -1, "revision_id");
    eq(String(updateRequest.body.content), "<title>A</title>\nA 的正文。\n本地新增的一行。\n", "更新内容");

    const after = dh.settings.state.docRecords[relPath];
    eq(after.documentId, before.documentId, "documentId 必须保持不变（原位更新，URL 不变）");
    eq(after.baseLocalHash, await sha256OfText("A 的正文。\n本地新增的一行。\n"), "本地基线应更新");
    eq(after.baseRemoteHash, await sha256OfText("# A\nA 的正文。\n本地新增的一行。\n"), "远端基线是取回形态");
    eq(docFake.docContent(before.documentId), "<title>A</title>\nA 的正文。\n本地新增的一行。\n", "远端文档内容");
    eq(docxNodes(docFake).length, docPaths.length + 3, "不该多出重复文档节点");

    return `PUT=1，documentId 保持 ${before.documentId}，远端=本地改动后的内容（取回形态记基线）`;
  });

  await scenario("18 文档模式：远端改一篇 → 1 次 pull，首行 H1 被下行规则删掉", async () => {
    const relPath = "Notes/B.md";
    const record = dh.settings.state.docRecords[relPath];
    ok(record, "缺少 B 的映射");
    docFake.setDocContent(record.documentId, "<title>B</title>\n远端改过的 B 正文。\n");

    const { result, delta } = await runDocRound(dh, "文档模式第 4 轮：远端改一篇");

    eq(result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(result.plan.counts.push ?? 0, 0, "不该有 push");
    eq(delta.docsUpdate + delta.docsCreate, 0, "拉取不该写飞书");
    eq(delta.move, 0, "拉取不该动结构");

    const written = readVaultFile(relPath, docRoot);
    eq(written, "远端改过的 B 正文。\n", "本地应写回下行规则处理后的内容");
    ok(!written.includes("# B"), "文档标题 H1 应该被 drop-title-heading 删掉");
    const after = dh.settings.state.docRecords[relPath];
    eq(after.baseRemoteHash, await sha256OfText("# B\n远端改过的 B 正文。\n"), "远端基线记取回形态（含 H1）");
    eq(after.baseLocalHash, await sha256OfText(written), "本地基线记写回后的内容");

    return `pull=1，本地写回后首行是「${written.split("\n")[0]}」（# B 已删），写飞书 0 次`;
  });

  await scenario("19 文档模式：两边都改 → 冲突副本，两边都不动", async () => {
    const relPath = "Notes/Sub/C.md";
    const record = dh.settings.state.docRecords[relPath];
    ok(record, "缺少 C 的映射");
    writeVaultFile(relPath, "本地改过的 C 正文。\n", docRoot);
    docFake.setDocContent(record.documentId, "<title>C</title>\n远端改过的 C 正文。\n");
    const copiesBefore = listConflictCopies(docRoot).length;

    const { result, delta } = await runDocRound(dh, "文档模式第 5 轮：两边都改");

    eq(result.plan.counts.conflict ?? 0, 1, "conflict 数量");
    eq(delta.docsUpdate + delta.docsCreate, 0, "冲突时不该写飞书");
    eq(readVaultFile(relPath, docRoot), "本地改过的 C 正文。\n", "冲突时本地不动");
    eq(docFake.docContent(record.documentId), "<title>C</title>\n远端改过的 C 正文。\n", "冲突时远端不动");

    const copies = listConflictCopies(docRoot);
    eq(copies.length - copiesBefore, 1, "应生成 1 个冲突副本");
    const copyPath = copies[copies.length - 1];
    eq(readVaultFile(copyPath, path.join(docRoot, CONFLICT_DIR_REL)), "# C\n远端改过的 C 正文。\n", "副本内容是远端取回形态");
    const entry = result.report.find((item) => item.action === "conflict");
    eq(entry?.copyPath, `${CONFLICT_DIR_REL}/${copyPath}`, "报告里的副本路径");

    return `conflict=1，副本 ${CONFLICT_DIR_REL}/${copyPath}，本地与远端均未改动`;
  });

  await scenario("20 文档模式：同一冲突重跑 → 不重复生成副本", async () => {
    const copiesBefore = listConflictCopies(docRoot).length;
    const { result, delta } = await runDocRound(dh, "文档模式第 6 轮：冲突未处理时重跑");

    eq(result.plan.counts.conflict ?? 0, 1, "仍是同一个冲突");
    eq(listConflictCopies(docRoot).length, copiesBefore, "不重复生成副本");
    eq(delta.docsUpdate + delta.docsCreate, 0, "0 次写请求");
    eq(
      result.report.filter((entry) => entry.action === "conflict" && (entry.message ?? "").includes("未重复生成副本")).length,
      1,
      "应报告复用旧副本",
    );

    return `冲突仍为 1 条、副本数不变（${copiesBefore}），create/update=0`;
  });

  await scenario("21 文档模式：上行规则（图片/Tab/脚注）与关掉规则后的差异", async () => {
    const ruleRoot = path.join(TMP_ROOT, "vault-doc-rules");
    writeDocVault(ruleRoot, {
      "图片笔记.md": "图片引用：\n\n![示例图](attachments/pic.png)\n\n\tTab 缩进的列表项\n\n脚注引用[^n]。\n\n[^n]: 脚注正文。\n",
    });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const rh = createDocHarness(fake, ruleRoot);

    const first = await runDocRound(rh, "规则第 1 轮：默认规则");
    eq(first.result.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");
    const createBody = createDocRequests(fake)[0]?.body;
    ok(createBody, "没有记录到创建请求");
    const sent = String(createBody.content);
    ok(sent.includes("![[attachments/pic.png]]"), `标准图片引用应被规范成 wikilink：${sent}`);
    ok(!sent.includes("![示例图]("), "转换后不该再有标准图片引用");
    ok(sent.includes("\n  Tab 缩进的列表项"), "行首 Tab 应转成 2 空格");
    ok(!sent.includes("\tTab 缩进"), "不该再留 Tab");
    ok(sent.includes("[^n]: 脚注正文。"), "脚注默认不降级（footnote-downgrade 默认关）");

    const rulesPath = path.join(ruleRoot, RULES_PATH);
    ok(fs.existsSync(rulesPath), `默认规则文件没有写出来：${rulesPath}`);
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8")) as {
      toFeishu: { id: string; enabled: boolean; description: string }[];
      toObsidian: { id: string; enabled: boolean; description: string }[];
    };
    eq(
      rules.toFeishu.map((rule) => rule.id).join("|"),
      "image-ref-normalize|tab-indent-to-spaces|math-escape-hash|math-trim-inline-spaces|inline-formula-to-block|block-formula-own-paragraph|footnote-downgrade|image-upload",
      "默认上行规则",
    );
    eq(rules.toObsidian.map((rule) => rule.id).join("|"), "unescape-image-markup|drop-title-heading|image-download|restore-image-ref", "默认下行规则");
    ok(rules.toFeishu.every((rule) => Boolean(rule.description)), "每条规则都要有 description");
    for (const rule of rules.toFeishu) {
      if (rule.id === "image-ref-normalize") rule.enabled = false;
    }
    fs.writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");

    writeVaultFile("图片笔记.md", `${readVaultFile("图片笔记.md", ruleRoot)}本地又改了一行。\n`, ruleRoot);
    const second = await runDocRound(rh, "规则第 2 轮：关掉 image-ref-normalize");
    eq(second.result.plan.counts.push ?? 0, 1, "push 数量");
    eq(second.delta.docsUpdate, 1, "PUT 次数");
    const updateBody = updateDocRequests(fake).at(-1)?.body;
    ok(updateBody, "没有记录到更新请求");
    const sentAgain = String(updateBody.content);
    ok(sentAgain.includes("![示例图](attachments/pic.png)"), "关掉规则后应原样保留标准图片引用");
    ok(!sentAgain.includes("![[attachments/pic.png]]"), "关掉规则后不该再转 wikilink");

    return "默认规则把 ![](path) 规范成 ![[path]]、Tab 转 2 空格、脚注不动；把 image-ref-normalize 关掉后原样发送";
  });

  await scenario("22 文档模式：0 字节笔记也会同步（md 模式会跳过）", async () => {
    const emptyRoot = path.join(TMP_ROOT, "vault-doc-empty");
    writeDocVault(emptyRoot, { "空笔记.md": "", "正常.md": "正文。\n" });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const eh = createDocHarness(fake, emptyRoot);

    const first = await runDocRound(eh, "0 字节第 1 轮");
    eq(first.result.plan.counts["create-remote"] ?? 0, 2, "空笔记也要新建文档");
    eq(first.result.plan.counts["empty-local"] ?? 0, 0, "文档模式没有 empty-local 这个动作");
    const emptyEntry = first.result.report.find((entry) => entry.relPath === "空笔记.md");
    ok((emptyEntry?.message ?? "").includes("空笔记在文档模式也会同步"), `报告要说明空笔记也会同步：${emptyEntry?.message ?? ""}`);
    const emptyDocumentId = eh.settings.state.docRecords["空笔记.md"]?.documentId;
    ok(emptyDocumentId, "空笔记没有记下 documentId");
    eq(fake.docContent(emptyDocumentId), "<title>空笔记</title>", "空笔记的 content 只有 <title>");

    const second = await runDocRound(eh, "0 字节第 2 轮");
    eq(nonSkipCount(second.result.plan), 0, "空笔记重跑也要 skip（不震荡）");
    eq(second.delta.docsCreate + second.delta.docsUpdate, 0, "0 次写请求");

    // 同样的 vault 用 md 模式看一眼：空文件会被判成 empty-local，不上传
    const mdFake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(mdFake.handler);
    const mh = createHarness(mdFake, { vaultRoot: emptyRoot, settings: { spaceId: SPACE_ID, rootNodeToken: "" } });
    const mdPlan = await mh.engine.run({ mode: "both", dryRun: true });
    eq(mdPlan.plan.counts["empty-local"] ?? 0, 1, "md 模式应跳过空文件");
    eq(mdPlan.plan.counts["create-remote"] ?? 0, 1, "md 模式只传非空文件");

    return "文档模式：空笔记也建文档（content 只有 <title>）、重跑 skip；md 模式：同一文件是 empty-local、不上传";
  });

  await scenario("23 文档模式：笔记名与目录同名 → 文档标题加 (note) 后缀且重跑稳定", async () => {
    const clashRoot = path.join(TMP_ROOT, "vault-doc-clash");
    writeDocVault(clashRoot, { "MyPapers.md": "笔记正文。\n", "MyPapers/内页.md": "内页正文。\n" });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const ch = createDocHarness(fake, clashRoot);

    const first = await runDocRound(ch, "同名冲突第 1 轮");
    eq(first.result.plan.counts["create-remote"] ?? 0, 2, "两篇笔记都要新建");
    const docTitles = docxNodes(fake).map((node) => node.title).sort();
    ok(docTitles.includes("MyPapers (note)"), `笔记标题应加后缀避免与目录撞名：${docTitles.join(" / ")}`);
    eq(docTitles.includes("MyPapers"), true, "目录容器仍然叫 MyPapers");
    eq(ch.settings.state.docRecords["MyPapers.md"]?.documentTitle, "MyPapers (note)", "映射里要记住改过的标题");

    const second = await runDocRound(ch, "同名冲突第 2 轮");
    eq(nonSkipCount(second.result.plan), 0, "重跑必须全部 skip（(note) 标题不能变成新文档）");
    eq(second.delta.docsCreate + second.delta.docsUpdate, 0, "0 次写请求");
    eq(second.result.plan.items.length, 2, "不该多出计划项（远端 (note) 文档不能被当成新笔记）");
    eq(docxNodes(fake).length, 4, "远端节点数不该变（2 目录 + 2 文档）");

    return `文档标题「MyPapers (note)」与目录「MyPapers」区分开，重跑 skip=${second.result.plan.counts.skip}、0 写请求`;
  });

  await scenario("24 文档模式：扁平模式（标题编码路径）往返稳定", async () => {
    const flatRoot = path.join(TMP_ROOT, "vault-doc-flat");
    writeDocVault(flatRoot, { "Notes/A.md": "A 正文。\n", "根.md": "根正文。\n" });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const fh = createDocHarness(fake, flatRoot, { folderMode: "flat", flatSeparator: "__" });

    const first = await runDocRound(fh, "扁平模式第 1 轮");
    eq(first.result.plan.counts["create-remote"] ?? 0, 2, "create-remote 数量");
    const titles = docxNodes(fake).map((node) => node.title).sort();
    eq(titles.join("|"), ["Notes__A", "根", path.basename(flatRoot)].sort().join("|"), "扁平模式的文档标题应编码路径");
    eq(fake.nodeCreations.length, 1, "扁平模式只该建存放根目录笔记的那一个页面");

    const second = await runDocRound(fh, "扁平模式第 2 轮");
    eq(nonSkipCount(second.result.plan), 0, "重跑全部 skip");
    eq(second.delta.docsCreate + second.delta.docsUpdate, 0, "0 次写请求");
    eq(fh.settings.state.docRecords["Notes/A.md"]?.documentTitle, "Notes__A", "映射里的标题");

    return `标题编码 Notes/A.md → Notes__A，重跑 skip=${second.result.plan.counts.skip}、0 写请求`;
  });

  await scenario("25 文档模式：单边删除只提示（recreate 开关只影响远端重建）", async () => {
    const delRoot = path.join(TMP_ROOT, "vault-doc-delete");
    writeDocVault(delRoot, { "A.md": "A 正文。\n", "B.md": "B 正文。\n", "C.md": "C 正文。\n" });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const h = createDocHarness(fake, delRoot);

    await runDocRound(h, "删除第 1 轮：建三篇");
    const recordA = h.settings.state.docRecords["A.md"];
    const recordB = h.settings.state.docRecords["B.md"];
    ok(recordA && recordB, "缺少映射");
    const nodeBCount = docxNodes(fake).length;

    fake.removeDocumentNode(recordA.documentId);
    fs.rmSync(path.join(delRoot, "B.md"));
    const { result, delta } = await runDocRound(h, "删除第 2 轮：远端删一篇、本地删一篇");

    eq(result.plan.counts["remote-deleted"] ?? 0, 1, "远端已删除的数量");
    eq(result.plan.counts["local-deleted"] ?? 0, 1, "本地已删除的数量");
    eq(result.plan.counts.skip ?? 0, 1, "没动过的那篇应该 skip");
    eq(delta.docsCreate + delta.docsUpdate, 0, "只提示不传播，0 次写请求");
    ok(fs.existsSync(path.join(delRoot, "A.md")), "远端删了不能自动删本地");
    eq(docxNodesOf(fake, "B").length, 1, "本地删了不能自动删远端");
    eq(docxNodes(fake).length, nodeBCount - 1, "远端少了一个文档节点");
    ok(h.settings.state.docRecords["B.md"], "本地已删除的笔记仍保留映射（删除不传播，将来恢复还能对上）");

    h.settings.recreateRemoteIfDeleted = true;
    const flagged = await runDocRound(h, "删除第 3 轮：打开重建开关但本地没改过");
    eq(flagged.result.plan.counts["remote-deleted"] ?? 0, 1, "本地没改过就不重建（与 md 模式同一套语义）");
    eq(flagged.delta.docsCreate, 0, "不该写");

    writeVaultFile("A.md", "A 正文。\n本地又改了。\n", delRoot);
    const recreated = await runDocRound(h, "删除第 4 轮：本地有改动 + 重建开关");
    eq(recreated.result.plan.counts["create-remote"] ?? 0, 1, "A 应该按设置重新上传");
    eq(recreated.delta.docsCreate, 1, "重建 1 篇文档");
    eq(recreated.delta.move, 1, "重建后要 move 回知识库");
    ok(h.settings.state.docRecords["A.md"].documentId !== recordA.documentId, "重建后 documentId 应该变新的");

    return "远端删→remote-deleted（本地保留）、本地删→local-deleted（远端保留）、0 写请求；打开重建开关后 create-remote=1 并重新 move";
  });

  await scenario("26 文档模式：目标/记录与新目标不符 → 按首次对接判定（不覆盖、不重复建）", async () => {
    const adoptRoot = path.join(TMP_ROOT, "vault-doc-adopt");
    writeDocVault(adoptRoot, { "A.md": "A 正文。\n", "B.md": "B 正文。\n" });
    const fake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(fake.handler);
    const h = createDocHarness(fake, adoptRoot);

    await runDocRound(h, "对接第 1 轮：建两篇");
    const nodesBefore = docxNodes(fake).length;

    // 模拟"上次是用 md 模式跑的"：target 里的模式标记不符 → 清空文档映射表，重新按首次对接判定
    h.settings.state.target = { spaceId: SPACE_ID, rootNodeToken: "", syncMode: "md" };
    const adopt = await runDocRound(h, "对接第 2 轮：模式标记不符");
    eq(adopt.result.plan.counts.link ?? 0, 2, "内容一致的两篇应该只建立映射");
    eq(nonSkipCount(adopt.result.plan), 2, "不该出现 create-remote/push");
    eq(adopt.delta.docsCreate + adopt.delta.docsUpdate + adopt.delta.move + adopt.delta.nodeCreate, 0, "不该有任何写操作");
    eq(docxNodes(fake).length, nodesBefore, "远端不该多出节点");
    ok(h.logs.warns.some((line) => line.includes("文档模式的同步目标已变更")), `应有目标变更提示：${h.logs.warns.join(" / ")}`);

    // 再模拟一次目标不符，但这次本地内容与远端不一致：必须判成冲突，绝不覆盖、也不新建重复文档
    h.settings.state.target = { spaceId: SPACE_ID, rootNodeToken: "", syncMode: "md" };
    writeVaultFile("A.md", "本地改成了完全不同的内容。\n", adoptRoot);
    const copiesBefore = listConflictCopies(adoptRoot).length;
    const clash = await runDocRound(h, "对接第 3 轮：目标不符且内容不同");
    eq(clash.result.plan.counts.conflict ?? 0, 1, "内容不同的那篇应判冲突");
    eq(clash.result.plan.counts.link ?? 0, 1, "内容相同的另一篇只建立映射");
    eq(clash.delta.docsCreate + clash.delta.docsUpdate + clash.delta.move + clash.delta.nodeCreate, 0, "不该有任何写操作");
    eq(readVaultFile("A.md", adoptRoot), "本地改成了完全不同的内容。\n", "冲突时本地不动");
    eq(listConflictCopies(adoptRoot).length - copiesBefore, 1, "应生成冲突副本");
    eq(docxNodes(fake).length, nodesBefore, "远端不该多出重复文档");

    return "target 模式标记不符 → 清空文档映射表并按首次对接判定：内容一致 link、内容不同 conflict，两次都 0 写操作、无重复文档";
  });

  // ---- 场景 27~31：删除传播（md 模式）
  const mdDelRoot = path.join(TMP_ROOT, "vault-md-delete");
  writeDocVault(mdDelRoot, {
    "A.md": "# A\nA 的正文。\n",
    "B.md": "# B\nB 的正文。\n",
    "C.md": "# C\nC 的正文。\n",
  });
  const mdDelFake = new FakeFeishu();
  __setRequestUrlHandler(mdDelFake.handler);
  const mdh = createHarness(mdDelFake, { vaultRoot: mdDelRoot, settings: { spaceId: SPACE_ID } });
  deleteFakes.push({ label: "md 删除传播", fake: mdDelFake });

  await scenario("27 删除传播（md 模式）：开关关闭时本地删除只提示、0 次 DELETE", async () => {
    const first = await runRound(mdh, "删除第 1 轮：建三篇", { mode: "both" });
    eq(first.plan.counts["create-remote"] ?? 0, 3, "首轮 create-remote 数量");
    const recordB = mdh.settings.state.records["B.md"];
    ok(recordB, "缺少 B 的映射");

    fs.rmSync(path.join(mdDelRoot, "B.md"));
    const round = await runRound(mdh, "删除第 2 轮：本地删了 B.md", { mode: "both" });

    eq(round.plan.counts["local-deleted"] ?? 0, 1, "local-deleted 数量");
    eq(round.plan.counts["delete-remote"] ?? 0, 0, "默认不该出现 delete-remote");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(mdh.settings.state.records["B.md"]?.fileToken, recordB.fileToken, "默认关闭时必须保留映射");
    eq(mdDelFake.remoteText("B.md"), "# B\nB 的正文。\n", "远端文件不该被删");
    eq(round.report.filter((entry) => entry.action === "delete-remote").length, 0, "报告里不该有删除动作");

    return `local-deleted=1、DELETE=0、映射保留、远端文件还在（默认行为与改之前一致）`;
  });

  await scenario("28 删除传播（md 模式）：打开后 本地删除 → 恰好 1 次 DELETE(type=file)", async () => {
    const recordB = mdh.settings.state.records["B.md"];
    ok(recordB, "上一轮应保留 B 的映射");
    const tokenB = recordB.fileToken;

    mdh.settings.propagateLocalDelete = true;
    const previewAll = await mdh.engine.run({ mode: "both", dryRun: true });
    eq(previewAll.plan.counts["delete-remote"] ?? 0, 1, "预演里应能看到 delete-remote");
    eq(childItems(previewAll.plan, "delete-remote").join("|"), "B.md", "预演里被删的 relPath");
    eq(mdh.fake.counters.deleteFile, 0, "预演绝不执行删除");
    const previewPull = await mdh.engine.run({ mode: "pull", dryRun: true });
    eq(previewPull.plan.counts["delete-remote"] ?? 0, 0, "只拉取模式不该删远端");
    const previewPush = await mdh.engine.run({ mode: "push", dryRun: true });
    eq(previewPush.plan.counts["delete-remote"] ?? 0, 1, "只推送模式应保留删除远端");
    eq(mdh.fake.counters.deleteFile, 0, "三次预演都不该有 DELETE");

    const round = await runRound(mdh, "删除第 3 轮：打开删除传播", { mode: "both" });

    eq(round.plan.counts["delete-remote"] ?? 0, 1, "delete-remote 数量");
    eq(childItems(round.plan, "delete-remote").join("|"), "B.md", "被删的 relPath");
    eq(round.plan.counts["local-deleted"] ?? 0, 0, "打开后不该还是「仅提示」");
    eq(round.delta.deleteFile, 1, "DELETE 调用次数");
    eq(mdDelFake.deleteRequests.length, 1, "DELETE 请求数");
    eq(mdDelFake.deleteRequests[0].token, tokenB, "DELETE 的 token 必须是该文件的 file_token");
    eq(mdDelFake.deleteRequests[0].type, "file", "DELETE 的 type");
    eq(mdh.settings.state.records["B.md"], undefined, "成功后要清掉映射");
    eq(mdDelFake.files.has(tokenB), false, "远端文件应已消失");
    eq(mdDelFake.fileNodeAt("B.md"), undefined, "远端节点应已消失");
    const entry = round.report.find((item) => item.action === "delete-remote");
    eq(entry?.ok, true, "删除应成功");
    ok((entry?.message ?? "").includes("回收站"), `报告要写清删除与可恢复：${entry?.message ?? ""}`);

    const next = await runRound(mdh, "删除第 4 轮：删完重跑", { mode: "both" });
    eq(next.plan.items.some((item) => item.relPath === "B.md"), false, "重跑不该再出现 B.md 的条目");
    eq(next.delta.deleteFile, 0, "不该重复删除");

    return `delete-remote=1、DELETE=1（type=file、token=${tokenB}）、映射清除、远端文件与节点消失、重跑无残留`;
  });

  await scenario("29 删除传播（md 模式）：本地删除但远端被改过 → 冲突、0 次 DELETE", async () => {
    const recordC = mdh.settings.state.records["C.md"];
    ok(recordC, "缺少 C 的映射");
    const copiesBefore = listConflictCopies(mdDelRoot).length;
    mdDelFake.editRemote("C.md", "# C\n远端改过的正文。\n");
    fs.rmSync(path.join(mdDelRoot, "C.md"));

    const round = await runRound(mdh, "删除第 5 轮：本地删 C、远端改 C", { mode: "both" });

    eq(round.plan.counts.conflict ?? 0, 1, "conflict 数量");
    eq(round.plan.counts["delete-remote"] ?? 0, 0, "远端被改过时绝不能删");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(mdDelFake.remoteText("C.md"), "# C\n远端改过的正文。\n", "远端文件必须保留");
    eq(listConflictCopies(mdDelRoot).length - copiesBefore, 1, "应生成冲突副本");

    return `conflict=1、DELETE=0，远端修改保留为 ${listConflictCopies(mdDelRoot).length} 个冲突副本之一`;
  });

  await scenario("30 删除传播（md 模式）：排除规则命中的路径不触发远端删除", async () => {
    fs.mkdirSync(path.join(mdDelRoot, "Excluded"), { recursive: true });
    writeVaultFile("Excluded/E.md", "# E\nE 的正文。\n", mdDelRoot);
    const pushed = await runRound(mdh, "删除第 6 轮：先传一篇 E.md", { mode: "both" });
    eq(pushed.plan.counts["create-remote"] ?? 0, 1, "E 应上传");
    const recordE = mdh.settings.state.records["Excluded/E.md"];
    ok(recordE, "缺少 E 的映射");
    const tokenE = recordE.fileToken;

    mdh.settings.excludePatterns = ".trash/**\nExcluded/**";
    fs.rmSync(path.join(mdDelRoot, "Excluded/E.md"));
    const round = await runRound(mdh, "删除第 7 轮：E 被排除规则命中且本地已删", { mode: "both" });

    eq(round.plan.items.some((item) => item.relPath === "Excluded/E.md"), false, "排除命中的路径不该出现在计划里");
    eq(round.plan.counts["delete-remote"] ?? 0, 0, "delete-remote 数量");
    eq(round.plan.counts["local-deleted"] ?? 0, 0, "也不该混进「仅提示」");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(mdDelFake.files.has(tokenE), true, "排除命中的远端文件必须保留");

    return `排除命中：计划里没有该条目、DELETE=0、远端文件（${tokenE}）完好`;
  });

  await scenario("31 删除传播（md 模式）：远端删除 → delete-local 移进 .trash", async () => {
    writeVaultFile("F.md", "# F\nF 的正文。\n", mdDelRoot);
    await runRound(mdh, "删除第 8 轮：先传一篇 F.md", { mode: "both" });
    ok(mdh.settings.state.records["F.md"], "缺少 F 的映射");
    mdDelFake.removeRemoteFile("F.md");

    const closed = await runRound(mdh, "删除第 9 轮：远端删 F（开关关闭）", { mode: "both" });
    eq(closed.plan.counts["remote-deleted"] ?? 0, 1, "关闭时仍是 remote-deleted");
    eq(closed.plan.counts["delete-local"] ?? 0, 0, "关闭时不该有 delete-local");
    eq(fs.existsSync(path.join(mdDelRoot, "F.md")), true, "关闭时本地文件必须还在");
    eq(mdh.vault.trashed.length, 0, "关闭时不应调用 trash");

    mdh.settings.propagateRemoteDelete = true;
    const round = await runRound(mdh, "删除第 10 轮：远端删 F（开关打开）", { mode: "both" });
    eq(round.plan.counts["delete-local"] ?? 0, 1, "delete-local 数量");
    eq(childItems(round.plan, "delete-local").join("|"), "F.md", "被删的 relPath");
    eq(fs.existsSync(path.join(mdDelRoot, "F.md")), false, "本地文件应已移走");
    eq(mdh.vault.trashed.join("|"), "F.md", "应通过 vault.trash 移走");
    eq(fs.existsSync(path.join(mdDelRoot, ".trash/F.md")), true, "文件应进了 .trash（不是永久删除）");
    eq(mdh.settings.state.records["F.md"], undefined, "成功后要清掉映射");

    const next = await runRound(mdh, "删除第 11 轮：删完重跑", { mode: "both" });
    eq(next.plan.items.some((item) => item.relPath === "F.md"), false, "重跑不该再出现 F.md 的条目");

    return `关闭时 remote-deleted 且本地保留；打开后 delete-local=1、文件进 .trash、映射清除、重跑无残留`;
  });

  await scenario("32 删除传播（md 模式）：删除失败时保留映射并下次重试", async () => {
    writeVaultFile("G.md", "# G\nG 的正文。\n", mdDelRoot);
    await runRound(mdh, "删除第 12 轮：先传一篇 G.md", { mode: "both" });
    const recordG = mdh.settings.state.records["G.md"];
    ok(recordG, "缺少 G 的映射");

    fs.rmSync(path.join(mdDelRoot, "G.md"));
    mdDelFake.rejectDeletes = true;
    const failed = await runRound(mdh, "删除第 13 轮：删除被拒", { mode: "both" });
    const entry = failed.report.find((item) => item.action === "delete-remote");
    eq(entry?.ok, false, "删除失败要如实报告");
    ok((entry?.message ?? "").includes("code=1061004"), `要带 code：${entry?.message ?? ""}`);
    ok((entry?.message ?? "").includes("log_id="), `要带 log_id：${entry?.message ?? ""}`);
    eq(mdh.settings.state.records["G.md"]?.fileToken, recordG.fileToken, "失败必须保留映射");
    eq(mdDelFake.files.has(recordG.fileToken), true, "失败时远端文件还在");

    mdDelFake.rejectDeletes = false;
    const retried = await runRound(mdh, "删除第 14 轮：恢复后重试", { mode: "both" });
    eq(retried.plan.counts["delete-remote"] ?? 0, 1, "下次同步应重试删除");
    eq(retried.report.find((item) => item.action === "delete-remote")?.ok, true, "重试应成功");
    eq(mdh.settings.state.records["G.md"], undefined, "成功后清掉映射");

    return "删除失败 → 报告带 code/log_id、映射保留、远端未动；恢复后下一轮自动重试成功";
  });

  // ---- 场景 33~38：删除传播（文档模式）
  const docDelRoot = path.join(TMP_ROOT, "vault-doc-delete-prop");
  writeDocVault(docDelRoot, {
    "A.md": "A 的正文。\n",
    "B.md": "B 的正文。\n",
    "C.md": "C 的正文。\n",
  });
  const docDelFake = new FakeFeishu();
  __setRequestUrlHandler(docDelFake.handler);
  const ddh = createDocHarness(docDelFake, docDelRoot, { rootNodeToken: ROOT_NODE });

  await scenario("33 删除传播（文档模式）：开关关闭时本地删除只提示、0 次 DELETE", async () => {
    const first = await runDocRound(ddh, "文档删除第 1 轮：建三篇");
    eq(first.result.plan.counts["create-remote"] ?? 0, 3, "首轮 create-remote 数量");
    const recordB = ddh.settings.state.docRecords["B.md"];
    ok(recordB, "缺少 B 的映射");

    fs.rmSync(path.join(docDelRoot, "B.md"));
    const round = await runDocRound(ddh, "文档删除第 2 轮：本地删了 B.md");

    eq(round.result.plan.counts["local-deleted"] ?? 0, 1, "local-deleted 数量");
    eq(round.result.plan.counts["delete-remote"] ?? 0, 0, "默认不该出现 delete-remote");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(ddh.settings.state.docRecords["B.md"]?.documentId, recordB.documentId, "默认关闭时必须保留映射");
    eq(docDelFake.docContent(recordB.documentId), "<title>B</title>\nB 的正文。\n", "远端文档不该被删");

    return "local-deleted=1、DELETE=0、映射保留、远端文档还在";
  });

  await scenario("34 删除传播（文档模式）：打开后 本地删除 → 恰好 1 次 DELETE(type=docx)", async () => {
    const recordB = ddh.settings.state.docRecords["B.md"];
    ok(recordB, "上一轮应保留 B 的映射");
    const documentId = recordB.documentId;

    ddh.settings.propagateLocalDelete = true;
    const previewAll = await ddh.engine.run({ mode: "both", dryRun: true });
    eq(previewAll.plan.counts["delete-remote"] ?? 0, 1, "预演里应能看到 delete-remote");
    eq(ddh.fake.counters.deleteFile, 0, "预演绝不执行删除");
    const previewPull = await ddh.engine.run({ mode: "pull", dryRun: true });
    eq(previewPull.plan.counts["delete-remote"] ?? 0, 0, "只拉取模式不该删远端");
    const previewPush = await ddh.engine.run({ mode: "push", dryRun: true });
    eq(previewPush.plan.counts["delete-remote"] ?? 0, 1, "只推送模式应保留删除远端");
    eq(ddh.fake.counters.deleteFile, 0, "三次预演都不该有 DELETE");

    const round = await runDocRound(ddh, "文档删除第 3 轮：打开删除传播");

    eq(round.result.plan.counts["delete-remote"] ?? 0, 1, "delete-remote 数量");
    eq(childItems(round.result.plan, "delete-remote").join("|"), "B.md", "被删的 relPath");
    eq(round.delta.deleteFile, 1, "DELETE 调用次数");
    eq(docDelFake.deleteRequests.length, 1, "DELETE 请求数");
    eq(docDelFake.deleteRequests[0].token, documentId, "DELETE 的 token 必须是该文档的 document_id");
    eq(docDelFake.deleteRequests[0].type, "docx", "DELETE 的 type");
    eq(ddh.settings.state.docRecords["B.md"], undefined, "成功后要清掉映射");
    eq(docDelFake.documents.has(documentId), false, "远端文档应已消失");
    eq(docxNodesOf(docDelFake, "B").length, 0, "远端节点应已消失");
    const entry = round.result.report.find((item) => item.action === "delete-remote");
    eq(entry?.ok, true, "删除应成功");
    ok((entry?.message ?? "").includes("回收站"), `报告要写清删除与可恢复：${entry?.message ?? ""}`);

    const next = await runDocRound(ddh, "文档删除第 4 轮：删完重跑");
    eq(next.result.plan.items.some((item) => item.relPath === "B.md"), false, "重跑不该再出现 B.md 的条目");
    eq(next.delta.deleteFile, 0, "不该重复删除");

    return `delete-remote=1、DELETE=1（type=docx、token=${documentId}）、映射清除、文档与节点消失、重跑无残留`;
  });

  await scenario("35 删除传播（文档模式）：本地删除但远端被改过 → 冲突、0 次 DELETE", async () => {
    const recordC = ddh.settings.state.docRecords["C.md"];
    ok(recordC, "缺少 C 的映射");
    const copiesBefore = listConflictCopies(docDelRoot).length;
    docDelFake.setDocContent(recordC.documentId, "<title>C</title>\n远端改过的 C 正文。\n");
    fs.rmSync(path.join(docDelRoot, "C.md"));

    const round = await runDocRound(ddh, "文档删除第 5 轮：本地删 C、远端改 C");

    eq(round.result.plan.counts.conflict ?? 0, 1, "conflict 数量");
    eq(round.result.plan.counts["delete-remote"] ?? 0, 0, "远端被改过时绝不能删");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(docDelFake.docContent(recordC.documentId), "<title>C</title>\n远端改过的 C 正文。\n", "远端文档必须保留");
    eq(listConflictCopies(docDelRoot).length - copiesBefore, 1, "应生成冲突副本");

    return "conflict=1、DELETE=0，远端文档修改完整保留并另存副本";
  });

  await scenario("36 删除传播（文档模式）：排除规则命中的路径不触发远端删除", async () => {
    fs.mkdirSync(path.join(docDelRoot, "Sub"), { recursive: true });
    writeVaultFile("Sub/E.md", "E 的正文。\n", docDelRoot);
    const pushed = await runDocRound(ddh, "文档删除第 6 轮：先传一篇 Sub/E.md");
    eq(pushed.result.plan.counts["create-remote"] ?? 0, 1, "E 应上传");
    const recordE = ddh.settings.state.docRecords["Sub/E.md"];
    ok(recordE, "缺少 E 的映射");

    ddh.settings.excludePatterns = ".trash/**\nSub/**";
    fs.rmSync(path.join(docDelRoot, "Sub/E.md"));
    const round = await runDocRound(ddh, "文档删除第 7 轮：E 被排除规则命中且本地已删");

    eq(round.result.plan.items.some((item) => item.relPath === "Sub/E.md"), false, "排除命中的路径不该出现在计划里");
    eq(round.result.plan.counts["delete-remote"] ?? 0, 0, "delete-remote 数量");
    eq(round.result.plan.counts["local-deleted"] ?? 0, 0, "也不该混进「仅提示」");
    eq(round.delta.deleteFile, 0, "DELETE 调用次数");
    eq(docDelFake.documents.has(recordE.documentId), true, "排除命中的远端文档必须保留");

    return `排除命中：计划里没有该条目、DELETE=0、远端文档（${recordE.documentId}）完好`;
  });

  await scenario("37 删除传播（文档模式）：远端删除 → delete-local 移进 .trash", async () => {
    writeVaultFile("F.md", "F 的正文。\n", docDelRoot);
    await runDocRound(ddh, "文档删除第 8 轮：先传一篇 F.md");
    const recordF = ddh.settings.state.docRecords["F.md"];
    ok(recordF, "缺少 F 的映射");
    docDelFake.removeDocumentNode(recordF.documentId);

    const closed = await runDocRound(ddh, "文档删除第 9 轮：远端删 F（开关关闭）");
    eq(closed.result.plan.counts["remote-deleted"] ?? 0, 1, "关闭时仍是 remote-deleted");
    eq(closed.result.plan.counts["delete-local"] ?? 0, 0, "关闭时不该有 delete-local");
    eq(fs.existsSync(path.join(docDelRoot, "F.md")), true, "关闭时本地文件必须还在");
    eq(ddh.vault.trashed.length, 0, "关闭时不应调用 trash");

    ddh.settings.propagateRemoteDelete = true;
    const round = await runDocRound(ddh, "文档删除第 10 轮：远端删 F（开关打开）");
    eq(round.result.plan.counts["delete-local"] ?? 0, 1, "delete-local 数量");
    eq(childItems(round.result.plan, "delete-local").join("|"), "F.md", "被删的 relPath");
    eq(fs.existsSync(path.join(docDelRoot, "F.md")), false, "本地文件应已移走");
    eq(ddh.vault.trashed.join("|"), "F.md", "应通过 vault.trash 移走");
    eq(fs.existsSync(path.join(docDelRoot, ".trash/F.md")), true, "文件应进了 .trash（不是永久删除）");
    eq(ddh.settings.state.docRecords["F.md"], undefined, "成功后要清掉映射");

    const next = await runDocRound(ddh, "文档删除第 11 轮：删完重跑");
    eq(next.result.plan.items.some((item) => item.relPath === "F.md"), false, "重跑不该再出现 F.md 的条目");

    return `关闭时 remote-deleted 且本地保留；打开后 delete-local=1、文件进 .trash、映射清除、重跑无残留`;
  });

  await scenario("38 删除传播（文档模式）：删除失败时保留映射并下次重试", async () => {
    writeVaultFile("G.md", "G 的正文。\n", docDelRoot);
    await runDocRound(ddh, "文档删除第 12 轮：先传一篇 G.md");
    const recordG = ddh.settings.state.docRecords["G.md"];
    ok(recordG, "缺少 G 的映射");

    fs.rmSync(path.join(docDelRoot, "G.md"));
    docDelFake.rejectDeletes = true;
    const failed = await runDocRound(ddh, "文档删除第 13 轮：删除被拒", "both", true);
    const entry = failed.result.report.find((item) => item.action === "delete-remote");
    eq(entry?.ok, false, "删除失败要如实报告");
    ok((entry?.message ?? "").includes("code=1061004"), `要带 code：${entry?.message ?? ""}`);
    ok((entry?.message ?? "").includes("log_id="), `要带 log_id：${entry?.message ?? ""}`);
    eq(ddh.settings.state.docRecords["G.md"]?.documentId, recordG.documentId, "失败必须保留映射");
    eq(docDelFake.documents.has(recordG.documentId), true, "失败时远端文档还在");

    docDelFake.rejectDeletes = false;
    const retried = await runDocRound(ddh, "文档删除第 14 轮：恢复后重试");
    eq(retried.result.plan.counts["delete-remote"] ?? 0, 1, "下次同步应重试删除");
    eq(retried.result.report.find((item) => item.action === "delete-remote")?.ok, true, "重试应成功");
    eq(ddh.settings.state.docRecords["G.md"], undefined, "成功后清掉映射");

    return "删除失败 → 报告带 code/log_id、映射保留、远端未动；恢复后下一轮自动重试成功";
  });

  // ---- 场景 39~46：文档模式图片（上行上传/绑定、下行下载/改写）
  const imgRoot = path.join(TMP_ROOT, "vault-doc-images");
  writeDocVault(imgRoot, { "图笔记.md": "正文第一行。\n\n![[attachments/pic.png]]\n\n正文最后一行。\n" });
  writeVaultBinary(imgRoot, "attachments/pic.png", PIXEL_PNG);
  const imgFake = new FakeFeishu();
  __setRequestUrlHandler(imgFake.handler);
  const ih = createDocHarness(imgFake, imgRoot, { rootNodeToken: ROOT_NODE });
  let firstImageToken = "";
  let imageDocId = "";

  await scenario("39 图片上行：本地图片上传成素材并绑定成图片块", async () => {
    const { result, delta } = await runDocRound(ih, "图片第 1 轮：首轮推送");
    eq(result.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");

    const createBody = createDocRequests(imgFake)[0]?.body;
    ok(createBody, "没有记录到创建请求");
    const sent = String(createBody.content);
    ok(!sent.includes("attachments/pic.png"), `发出的内容里不该还有本地路径：${sent}`);
    const marker = /<img path="(@lcli_img_[0-9a-f]{32})"\/>/.exec(sent)?.[1];
    ok(marker, `发出的内容里应有官方占位标记：${sent}`);

    imageDocId = ih.settings.state.docRecords["图笔记.md"]?.documentId ?? "";
    ok(imageDocId, "没有记下 documentId");
    eq(delta.mediaUpload, 1, "素材上传次数");
    const upload = imgFake.mediaUploads[0];
    ok(upload, "没有记录到素材上传请求");
    eq(upload.parentType, "docx_image", "素材 parent_type");
    eq(upload.documentId, imageDocId, "素材 extra.drive_route_token 必须是文档 id");
    eq(upload.fileName, "pic.png", "素材 file_name");
    eq(upload.size, PIXEL_PNG.length, "素材 size 字段");
    eq(upload.actualSize, PIXEL_PNG.length, "素材实际字节数");
    const blocks = imgFake.docImageBlocks(imageDocId);
    eq(blocks.length, 1, "文档里应有一个图片块");
    eq(upload.blockId, blocks[0].blockId, "素材 parent_node 必须是占位块的 block_id");

    eq(delta.blockBind, 1, "绑定次数");
    eq(imgFake.bindRequests[0]?.fileToken, upload.fileToken, "绑定必须用上传返回的 file_token");
    eq(blocks[0].fileToken, upload.fileToken, "远端图片块应绑上素材");
    firstImageToken = upload.fileToken;

    const fetched = imgFake.docMarkdown(imageDocId);
    ok(!fetched.includes("@lcli_img_"), `取回内容里不该残留占位标记：${fetched}`);
    ok(
      new RegExp(`!\\[[^\\]]*\\]\\(https://open\\.feishu\\.cn/open-apis/drive/v1/medias/${firstImageToken}/download\\)`).test(fetched),
      `取回内容里应是图片引用：${fetched}`,
    );
    const record = ih.settings.state.docRecords["图笔记.md"];
    eq(record?.baseRemoteHash, await sha256OfText(normalizeRemoteImageUrls(fetched)), "远端基线记归一化后的取回形态");

    return `占位→上传(${firstImageToken})→绑定，远端图片块已就绪，取回内容里没有本地路径与标记`;
  });

  await scenario("40 图片上行：无改动重跑 0 次上传/绑定（图片缓存命中）", async () => {
    const { result, delta } = await runDocRound(ih, "图片第 2 轮：无改动重跑");
    eq(result.plan.counts.skip ?? 0, 1, "应 skip");
    eq(delta.mediaUpload + delta.blockBind, 0, "0 次素材上传/绑定");
    eq(delta.mediaDownload, 0, "skip 时不该下载图片");
    eq(delta.docsUpdate + delta.docsCreate, 0, "0 次文档写请求");
    return "全 skip，素材上传/绑定/下载都是 0";
  });

  await scenario("41 图片上行：只改正文时复用已上传素材，不重传", async () => {
    writeVaultFile("图笔记.md", "正文改过了。\n\n![[attachments/pic.png]]\n", imgRoot);
    const { result, delta } = await runDocRound(ih, "图片第 3 轮：改正文，图片没变");

    eq(result.plan.counts.push ?? 0, 1, "push 数量");
    eq(delta.docsUpdate, 1, "PUT 次数");
    eq(delta.mediaUpload, 0, "图片没变不该重传素材");
    eq(delta.blockBind, 1, "应把已上传素材绑到新的占位块");
    eq(imgFake.bindRequests.at(-1)?.fileToken, firstImageToken, "复用的必须还是同一个素材 token");
    const blocks = imgFake.docImageBlocks(imageDocId);
    eq(blocks.length, 1, "文档里仍应只有一个图片块");
    eq(blocks[0].fileToken, firstImageToken, "复用绑定后块仍指向该素材");
    ok(imgFake.docMarkdown(imageDocId).includes(`/medias/${firstImageToken}/download`), "取回内容里仍是这张图");

    return `PUT=1、上传=0（复用 ${firstImageToken}）、绑定=1，媒体 token 不变`;
  });

  await scenario("42 图片下行：远端新增图片 → 下载到附件目录并改写成 wikilink", async () => {
    const remoteBytes = Buffer.concat([PIXEL_PNG, Buffer.from("remote-image-marker", "utf8")]);
    const remoteToken = imgFake.insertRemoteImage(imageDocId, { caption: "远程插图", bytes: remoteBytes, fileName: "remote.png" });
    const expectedName = `image-${remoteToken.slice(-8)}.png`;

    const { result, delta } = await runDocRound(ih, "图片第 4 轮：远端插了一张图");
    eq(result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(delta.mediaDownload, 1, "应下载 1 张图");

    const attachmentPath = path.join(imgRoot, "attachments", expectedName);
    ok(fs.existsSync(attachmentPath), `附件没落盘：attachments/${expectedName}`);
    eq(fs.readFileSync(attachmentPath).equals(remoteBytes), true, "附件内容应与远端字节一致");
    const local = readVaultFile("图笔记.md", imgRoot);
    ok(local.includes(`![[${expectedName}]]`), `本地引用应改写成本地附件 wikilink（最短路径写法）：${local}`);
    ok(!local.includes("open-apis/drive"), "本地不该留下远程图片地址");
    eq(fs.readdirSync(path.join(imgRoot, "attachments")).sort().join("|"), ["pic.png", expectedName].sort().join("|"), "附件目录内容");

    const next = await runDocRound(ih, "图片第 5 轮：无改动重跑");
    eq(next.result.plan.counts.skip ?? 0, 1, "应 skip");
    eq(next.delta.mediaDownload, 0, "不该重复下载");
    eq(fs.readdirSync(path.join(imgRoot, "attachments")).length, 2, "不该新增副本（例如 -1 后缀）");

    return `下载 1 张 → attachments/${expectedName}，引用改成 ![[…]]，重跑 skip 且不新增副本`;
  });

  await scenario("43 图片上行：找不到的本地图片与外链都不处理、报告里说明", async () => {
    writeVaultFile("缺图.md", "缺图：![[attachments/nope.png]]\n\n外链：![ext](https://example.com/x.png)\n", imgRoot);
    const { result, delta } = await runDocRound(ih, "图片第 6 轮：缺图与外链");

    eq(result.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");
    eq(delta.mediaUpload, 0, "不该上传任何素材");
    const sent = String(createDocRequests(imgFake).at(-1)?.body.content ?? "");
    ok(sent.includes("![[attachments/nope.png]]"), `找不到的本地图片应原样保留：${sent}`);
    ok(sent.includes("![ext](https://example.com/x.png)"), `外链应原样保留：${sent}`);
    const entry = result.report.find((item) => item.relPath === "缺图.md");
    ok((entry?.message ?? "").includes("找不到"), `报告要说明原因：${entry?.message ?? ""}`);

    return "缺图与外链都原样发送，报告写明「找不到」，0 次素材上传";
  });

  await scenario("44 图片上行：关掉 image-upload 规则后恢复原样发送", async () => {
    const rulesPath = path.join(imgRoot, RULES_PATH);
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8")) as { toFeishu: { id: string; enabled: boolean }[] };
    for (const rule of rules.toFeishu) if (rule.id === "image-upload") rule.enabled = false;
    fs.writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");

    writeVaultFile("图笔记.md", "正文又改了。\n\n![[attachments/pic.png]]\n", imgRoot);
    const { result, delta } = await runDocRound(ih, "图片第 7 轮：关掉 image-upload");

    eq(result.plan.counts.push ?? 0, 1, "push 数量");
    eq(delta.mediaUpload, 0, "关掉规则后不该上传素材");
    const sent = String(updateDocRequests(imgFake).at(-1)?.body.content ?? "");
    ok(sent.includes("![[attachments/pic.png]]"), `关掉规则后图片引用应原样发送：${sent}`);
    ok(!sent.includes("@lcli_img_"), "不该出现占位标记");

    return "image-upload=false：引用原样作为文本发出，0 次素材上传";
  });

  await scenario("45 图片下行：素材下载失败时保留引用、不中断拉取", async () => {
    imgFake.rejectMediaDownload = true;
    const remoteToken = imgFake.insertRemoteImage(imageDocId, { caption: "下载会失败的图", bytes: PIXEL_PNG, fileName: "fail.png" });
    const before = fs.readdirSync(path.join(imgRoot, "attachments")).length;

    const { result, delta } = await runDocRound(ih, "图片第 8 轮：远端插图但下载被拒");
    eq(result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(result.report.filter((item) => !item.ok).length, 0, "下载失败不该让 pull 变成失败");
    eq(delta.mediaDownload, 1, "尝试下载 1 次");
    const local = readVaultFile("图笔记.md", imgRoot);
    ok(local.includes(`medias/${remoteToken}/download`), `下载失败的那张图应保留远程引用：${local}`);
    eq(fs.readdirSync(path.join(imgRoot, "attachments")).length, before, "附件目录不该新增文件");
    for (const name of [...local.matchAll(/!\[\[attachments\/([^\]]+)\]\]/g)].map((match) => match[1])) {
      ok(fs.existsSync(path.join(imgRoot, "attachments", name)), `本地引用的附件必须真实存在：${name}`);
    }
    const entry = result.report.find((item) => item.relPath === "图笔记.md");
    ok((entry?.message ?? "").includes("下载失败"), `报告要说明下载失败：${entry?.message ?? ""}`);
    ok((entry?.message ?? "").includes(remoteToken), "报告里应带上素材 token 便于排查");

    const next = await runDocRound(ih, "图片第 9 轮：下载失败后重跑");
    eq(nonSkipCount(next.result.plan), 0, "失败后仍按基线判为 skip（远端变化时才会重试）");
    eq(next.delta.mediaDownload, 0, "未变化时不该再尝试下载");

    return "下载被拒：本地保留远程引用、附件不落盘、pull 仍算成功，报告写明原因";
  });

  await scenario("46 图片下行：取回 URL 不带素材 token 时按文档图片块顺序兜底", async () => {
    const plainRoot = path.join(TMP_ROOT, "vault-doc-images-plain");
    writeDocVault(plainRoot, { "顺序图.md": "正文。\n" });
    const fake = new FakeFeishu();
    fake.docImagePlainUrl = true;
    __setRequestUrlHandler(fake.handler);
    const h = createDocHarness(fake, plainRoot, { rootNodeToken: ROOT_NODE });

    await runDocRound(h, "顺序兜底第 1 轮：建文档");
    const documentId = h.settings.state.docRecords["顺序图.md"]?.documentId;
    ok(documentId, "缺少 documentId");
    const token = fake.insertRemoteImage(documentId, { caption: "无 token 的图", bytes: PIXEL_PNG, fileName: "plain.png" });

    const { result, delta } = await runDocRound(h, "顺序兜底第 2 轮：远端插图");
    eq(result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(delta.mediaDownload, 1, "应下载 1 张图");
    const local = readVaultFile("顺序图.md", plainRoot);
    ok(
      local.includes(`![[image-${token.slice(-8)}.png]]`),
      `应按文档块顺序解析出素材并改写成本地附件 wikilink（最短路径写法）：${local}`,
    );
    eq(fs.existsSync(path.join(plainRoot, "attachments", `image-${token.slice(-8)}.png`)), true, "附件应落盘");

    return `URL 无 token：靠 GET blocks 顺序匹配到 ${token}，本地改写为 ![[…]]`;
  });

  await scenario("47 图片下行：关掉 image-download 规则后不下载、不改写", async () => {
    // 场景 46 换过全局 handler，这里换回自己的假服务器（id 是每台假服务器自增的）
    __setRequestUrlHandler(imgFake.handler);
    const rulesPath = path.join(imgRoot, RULES_PATH);
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8")) as { toObsidian: { id: string; enabled: boolean }[] };
    for (const rule of rules.toObsidian) if (rule.id === "image-download") rule.enabled = false;
    fs.writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");

    const remoteToken = imgFake.insertRemoteImage(imageDocId, { caption: "规则关掉后的图", bytes: Buffer.concat([PIXEL_PNG, Buffer.from("x")]), fileName: "off.png" });
    const before = fs.readdirSync(path.join(imgRoot, "attachments")).length;
    const { result, delta } = await runDocRound(ih, "图片第 10 轮：关掉 image-download");

    eq(result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(delta.mediaDownload, 0, "关掉规则后不该下载素材");
    eq(fs.readdirSync(path.join(imgRoot, "attachments")).length, before, "附件目录不该新增文件");
    const local = readVaultFile("图笔记.md", imgRoot);
    ok(local.includes(`medias/${remoteToken}/download`), `关掉规则后应保留远程图片地址：${local}`);

    return "image-download=false：取回内容里的图片地址原样写回本地，0 次素材下载";
  });

  // ---- 场景 48~54：远端变更判定的元数据快路径
  const metaRoot = path.join(TMP_ROOT, "vault-doc-meta");
  writeDocVault(metaRoot, { "一.md": "第一篇。\n", "二.md": "第二篇。\n", "三.md": "第三篇。\n" });
  const metaFake = new FakeFeishu();
  __setRequestUrlHandler(metaFake.handler);
  const metaHarness = createDocHarness(metaFake, metaRoot, { rootNodeToken: ROOT_NODE });

  await scenario("48 元数据快路径：首轮记下修改时间，无改动重跑 0 次取回", async () => {
    const first = await runDocRound(metaHarness, "元数据第 1 轮：首轮建三篇");
    eq(first.result.plan.counts["create-remote"] ?? 0, 3, "create-remote 数量");
    eq(first.delta.docsFetch, 3, "新建后每篇都要取回记远端基线");
    for (const [relPath, record] of Object.entries(metaHarness.settings.state.docRecords)) {
      ok(record.remoteModifiedTime, `${relPath} 的记录里应有远端修改时间`);
    }

    const second = await runDocRound(metaHarness, "元数据第 2 轮：无改动");
    eq(nonSkipCount(second.result.plan), 0, "全部 skip");
    eq(second.delta.docsFetch, 0, "时间戳没变就不取回全文");
    eq(second.delta.meta, 1, "只发一次批量元数据请求");
    eq(second.delta.docsCreate + second.delta.docsUpdate, 0, "0 次写请求");

    return `3 篇文档：首轮 3 次取回 → 第 2 轮 0 次取回（只 1 次 batch_query），全 skip`;
  });

  await scenario("49 元数据快路径：远端改一篇 → 恰好 1 次取回 + 1 次 pull", async () => {
    const record = metaHarness.settings.state.docRecords["二.md"];
    ok(record, "缺少二.md 的映射");
    const before = record.remoteModifiedTime;

    metaFake.setDocContent(record.documentId, "<title>二</title>\n远端改过的第二篇。\n");
    const round = await runDocRound(metaHarness, "元数据第 3 轮：远端改一篇");

    eq(round.result.plan.counts.pull ?? 0, 1, "pull 数量");
    eq(round.delta.docsFetch, 1, "只有时间戳变了的那篇才取回");
    eq(round.delta.meta, 2, "一轮查一次计划元数据 + 变更后刷新一次");
    eq(readVaultFile("二.md", metaRoot), "远端改过的第二篇。\n", "本地写回");
    eq(nonSkipCount(round.result.plan), 1, "另外两篇不受影响");
    ok(metaHarness.settings.state.docRecords["二.md"]?.remoteModifiedTime !== before, "拉取后时间戳应刷新");

    const next = await runDocRound(metaHarness, "元数据第 4 轮：拉取后重跑");
    eq(next.delta.docsFetch, 0, "时间戳刷新后下一轮又走快路径");
    eq(nonSkipCount(next.result.plan), 0, "全部 skip");

    return `远端改 1 篇：fetch=1、pull=1；下一轮 fetch=0`;
  });

  await scenario("50 元数据快路径：本地改一篇推送后，下一轮 0 次取回", async () => {
    writeVaultFile("三.md", "第三篇改过了。\n", metaRoot);
    const push = await runDocRound(metaHarness, "元数据第 5 轮：本地改一篇");

    eq(push.result.plan.counts.push ?? 0, 1, "push 数量");
    eq(push.delta.docsUpdate, 1, "PUT 次数");
    eq(push.delta.docsFetch, 1, "写完取回一次记「取回形态」基线");
    eq(push.delta.meta, 2, "计划一次 + 推送后刷新一次元数据");
    ok(metaHarness.settings.state.docRecords["三.md"]?.remoteModifiedTime, "推送后记录里应有新的时间戳");

    const next = await runDocRound(metaHarness, "元数据第 6 轮：推送后重跑");
    eq(next.delta.docsFetch, 0, "推送后下一轮 0 次取回");
    eq(next.delta.meta, 1, "只查元数据");
    eq(nonSkipCount(next.result.plan), 0, "全部 skip");

    return `推送：PUT=1 + 1 次基线取回 → 下一轮 fetch=0`;
  });

  await scenario("51 元数据快路径：记录里没有时间戳（老状态）仍会逐篇取回", async () => {
    for (const record of Object.values(metaHarness.settings.state.docRecords)) delete record.remoteModifiedTime;

    const round = await runDocRound(metaHarness, "元数据第 7 轮：记录里没有时间戳");
    eq(round.delta.docsFetch, 3, "没有时间戳就要逐篇取回（不能因此漏判远端变更）");
    eq(nonSkipCount(round.result.plan), 0, "内容其实没变，仍然全部 skip");
    for (const [relPath, record] of Object.entries(metaHarness.settings.state.docRecords)) {
      ok(record.remoteModifiedTime, `${relPath} 取回校验后应补上时间戳`);
    }

    const next = await runDocRound(metaHarness, "元数据第 8 轮：补上时间戳之后");
    eq(next.delta.docsFetch, 0, "补上时间戳后回到快路径");

    return "老状态（无时间戳）：3 次取回并补上时间戳，下一轮回到 0 次取回";
  });

  await scenario("52 元数据快路径：元数据接口失败 → 退回逐篇取回，不漏判也不失败", async () => {
    const record = metaHarness.settings.state.docRecords["一.md"];
    ok(record, "缺少一.md 的映射");
    metaFake.rejectMetaQuery = true;
    metaFake.setDocContent(record.documentId, "<title>一</title>\n远端改过的第一篇。\n");

    const round = await runDocRound(metaHarness, "元数据第 9 轮：元数据接口失败");
    eq(round.result.plan.counts.pull ?? 0, 1, "元数据失败也要能看出远端变了");
    eq(round.delta.docsFetch, 3, "退回逐篇取回");
    eq(round.result.report.filter((item) => !item.ok).length, 0, "整轮同步不该失败");
    eq(readVaultFile("一.md", metaRoot), "远端改过的第一篇。\n", "本地被正确拉取");
    ok(metaHarness.logs.warns.some((line) => line.includes("批量读取远端文档元数据失败")), "日志要说明退回了逐篇校验");

    metaFake.rejectMetaQuery = false;
    const recovered = await runDocRound(metaHarness, "元数据第 10 轮：元数据恢复后");
    eq(recovered.delta.docsFetch, 1, "只有时间戳没补上的那篇取回一次");
    eq(recovered.delta.docsCreate + recovered.delta.docsUpdate, 0, "0 次写请求");
    const settled = await runDocRound(metaHarness, "元数据第 11 轮：时间戳补齐后");
    eq(settled.delta.docsFetch, 0, "补齐后回到快路径");

    return "元数据失败：退回 3 次逐篇取回并正确 pull、整轮不失败；恢复后 1 次取回补齐时间戳，再下一轮回到 0 次";
  });

  await scenario("53 元数据快路径：安全阀打开时每轮都取回全文", async () => {
    metaHarness.settings.docVerifyRemoteByContent = true;
    const round = await runDocRound(metaHarness, "元数据第 12 轮：安全阀打开");

    eq(round.delta.docsFetch, 3, "打开安全阀后每轮都取回全文校验");
    eq(round.delta.meta, 0, "不再需要元数据请求（回到旧行为）");
    eq(nonSkipCount(round.result.plan), 0, "内容没变仍是 skip");
    eq(round.delta.docsCreate + round.delta.docsUpdate, 0, "0 次写请求");
    metaHarness.settings.docVerifyRemoteByContent = false;

    return "安全阀打开：fetch=3、meta=0（等于改造前行为）";
  });

  await scenario("54 元数据快路径：同一秒内的远端改动会被漏判（如实复现并说明）", async () => {
    const record = metaHarness.settings.state.docRecords["一.md"];
    ok(record, "缺少一.md 的映射");
    // 时间戳没变（秒级）但内容变了：快路径这一轮看不出变化
    metaFake.editDocContentWithoutTimeBump(record.documentId, "<title>一</title>\n同一秒内的远端改动。\n");

    const missed = await runDocRound(metaHarness, "元数据第 13 轮：内容变了但时间戳没变");
    eq(missed.delta.docsFetch, 0, "时间戳没变就不取回（这是快路径的已知代价）");
    eq(nonSkipCount(missed.result.plan), 0, "本轮判为 skip");
    eq(readVaultFile("一.md", metaRoot), "远端改过的第一篇。\n", "本地这轮不会更新");
    eq(metaFake.docModifyTimeOf(record.documentId), record.remoteModifiedTime, "这一轮时间戳确实没变（漏判的前提）");

    metaHarness.settings.docVerifyRemoteByContent = true;
    const detected = await runDocRound(metaHarness, "元数据第 14 轮：打开安全阀后立刻发现");
    eq(detected.result.plan.counts.pull ?? 0, 1, "安全阀能立刻发现漏判的改动");
    eq(readVaultFile("一.md", metaRoot), "同一秒内的远端改动。\n", "本地被拉取更新");
    metaHarness.settings.docVerifyRemoteByContent = false;

    return "时间戳没变但内容变了：快路径漏判 1 轮（如实复现），开安全阀立刻补上";
  });

  // ---- 场景 55：公式排版差异不回写本地（零内容 diff，文档模式）
  await scenario("55 公式：远端只差排版归一化时不回写本地", async () => {
    const formulaRoot = path.join(TMP_ROOT, "vault-formula");
    const rel = "公式排版场景.md";
    const original = "公式排版场景（场景 55）\n\n讲解 $$a=b$$ 收尾\n\n行内公式 $URL = path#fragment$\n";
    writeDocVault(formulaRoot, { [rel]: original });

    const formulaFake = new FakeFeishu({ seedRootNode: false });
    __setRequestUrlHandler(formulaFake.handler);
    const fh = createDocHarness(formulaFake, formulaRoot);

    const pushRound = await runDocRound(fh, "场景 55：先上传新笔记");
    eq(pushRound.result.plan.counts["create-remote"] ?? 0, 1, "create-remote 数量");
    const sent = String(createDocRequests(formulaFake)[0]?.body?.content ?? "");
    ok(sent.includes("讲解\n\n$$a=b$$\n\n收尾"), `块级公式应独占段落：${sent}`);
    ok(sent.includes("$URL = path\\#fragment$"), `行内公式的 # 应被转义：${sent}`);

    const record = fh.settings.state.docRecords[rel];
    ok(record, "缺少映射记录");

    // 远端恰好等于"我们发上去的归一化形态"：差异只来自排版，本地不该被改写
    const normalized = applyRules(
      "toFeishu",
      original,
      { relPath: rel, documentTitle: "公式排版场景", localContent: original },
      defaultRulesFile(),
    );
    formulaFake.setDocContent(record.documentId, normalized);
    const cosmeticRound = await runDocRound(fh, "场景 55：远端只有排版差异");
    ok(childItems(cosmeticRound.result.plan, "pull").includes(rel), "计划里仍应判为 pull");
    eq(readVaultFile(rel, formulaRoot), original, "纯排版差异不应回写本地（零内容 diff）");

    const stableRound = await runDocRound(fh, "场景 55：确认基线已跟上");
    ok(childItems(stableRound.result.plan, "skip").includes(rel), "基线更新后该笔记应判为 skip");
    ok(!childItems(stableRound.result.plan, "pull").includes(rel), "不应反复判定为 pull");

    const realEdit = `${normalized}远端真实新增一行，用来确认真正的改动仍会拉取。\n`;
    formulaFake.setDocContent(record.documentId, realEdit);
    const realRound = await runDocRound(fh, "场景 55：远端真实改动");
    ok(childItems(realRound.result.plan, "pull").includes(rel), "真实远端改动仍应走 pull");
    ok(readVaultFile(rel, formulaRoot).includes("远端真实新增一行，用来确认真正的改动仍会拉取"), "真实改动应被拉取到本地");

    // 强制重推：已同步的笔记也要再发一遍（改了上行规则后刷新历史文档用）
    const idleRound = await runDocRound(fh, "场景 55：常规同步应为 skip");
    ok(childItems(idleRound.result.plan, "skip").includes(rel), "常规同步应判为 skip");
    const updatesBefore = formulaFake.counters.docsUpdate;
    const forced = await fh.engine.run({ mode: "push", forcePush: true, confirm: async () => "all" });
    ok(childItems(forced.plan, "push").includes(rel), `强制重推应包含本笔记：${childItems(forced.plan, "push").join("|")}`);
    eq(formulaFake.counters.docsUpdate - updatesBefore, 1, "强制重推应真的写一次飞书");

    // 请求被服务端挂住时不能永远等：超时按网络异常重试，最终报错并继续下一篇
    const passThrough = formulaFake.handler;
    __setRequestUrlHandler((options) =>
      options.method === "PUT" && options.url.includes("/docs_ai/v1/documents/")
        ? new Promise(() => {})
        : passThrough(options),
    );
    setRequestBudgetForTest(100);
    const hungStartedAt = Date.now();
    console.log("\n=== 场景 55：请求被挂住（用强制重推触发 PUT）===");
    const hung = await fh.engine.run({ mode: "push", forcePush: true, confirm: async () => "all" });
    const hungMs = Date.now() - hungStartedAt;
    setRequestBudgetForTest(undefined);
    const hungFailures = hung.report.filter((entry) => !entry.ok);
    ok(childItems(hung.plan, "push").includes(rel), "挂住那轮应把本笔记判成 push");
    ok(hungFailures.length > 0, "挂住的请求应报失败，不能静默跳过");
    ok(
      hungFailures.some((entry) => /没有响应|请求超时/.test(entry.message ?? "")),
      `失败原因应是超时：${hungFailures.map((entry) => entry.message).join(" | ")}`,
    );
    ok(hungMs < 30_000, `超时后应及时结束，实际 ${hungMs}ms`);

    __setRequestUrlHandler(fake.handler);
    return "排版差异不回写、真实改动仍拉取、强制重推可用、挂住会超时报错";
  });

  // ---- 汇总
  const failures: string[] = scenarioResults.filter((item) => !item.ok).map((item) => `${item.name}：${item.detail}`);
  if (fake.duplicateTitles.length > 0) failures.push(`同名节点 ${fake.duplicateTitles.length} 个`);
  if (fake.unknownRoutes.length > 0) failures.push(`未实现的端点 ${fake.unknownRoutes.join(", ")}`);
  if (uncaught.length > 0) failures.push(`未捕获异常：${uncaught.join(" / ")}`);
  for (const entry of [...docFakes, ...deleteFakes]) {
    if (entry.fake.unknownRoutes.length > 0) failures.push(`删除/文档模式（${entry.label}）未实现的端点 ${entry.fake.unknownRoutes.join(", ")}`);
    if (entry.fake.duplicateTitles.length > 0) failures.push(`删除/文档模式（${entry.label}）同名节点 ${entry.fake.duplicateTitles.length} 个`);
  }

  console.log("\n================ 结果汇总 ================");
  for (const item of scenarioResults) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name} —— ${item.detail}`);
  console.log(`\n模式一（指定 rootNodeToken）最终计数：upload_all=${fake.counters.uploadAll}，download=${fake.counters.download}，meta=${fake.counters.meta}，nodeList=${fake.counters.nodeList}，nodeCreate=${fake.counters.nodeCreate}，nodeByToken=${fake.counters.nodeByToken}，move=${fake.counters.move}`);
  console.log(`远端：file 节点 ${fake.fileNodes().length} 个，容器节点 ${[...fake.nodes.values()].length - fake.fileNodes().length} 个，冲突副本 ${listConflictCopies().length} 个`);
  console.log(`本地 logger：warn ${h.logs.warns.length} 条，error ${h.logs.errors.length} 条`);
  console.log(`全局：同名节点 ${fake.duplicateTitles.length} 个，未实现端点 ${fake.unknownRoutes.length} 个，未捕获异常 ${uncaught.length} 个`);
  for (const entry of newModeFakes) {
    const counters = entry.fake.counters;
    console.log(`模式二（留空 rootNodeToken）${entry.label}：upload_all=${counters.uploadAll}，nodeCreate=${counters.nodeCreate}，nodeList=${counters.nodeList}，download=${counters.download}，move=${counters.move}，同名节点=${entry.fake.duplicateTitles.length}，未实现端点=${entry.fake.unknownRoutes.length}`);
  }
  for (const entry of docFakes) {
    const counters = entry.fake.counters;
    console.log(`文档模式 ${entry.label}：docsCreate=${counters.docsCreate}，docsUpdate=${counters.docsUpdate}，docsFetch=${counters.docsFetch}，nodeCreate=${counters.nodeCreate}，move=${counters.move}，uploadAll=${counters.uploadAll}，delete=${counters.deleteFile}，同名节点=${entry.fake.duplicateTitles.length}，未实现端点=${entry.fake.unknownRoutes.length}`);
  }
  for (const entry of deleteFakes) {
    const counters = entry.fake.counters;
    console.log(`删除传播 ${entry.label}：upload_all=${counters.uploadAll}，nodeCreate=${counters.nodeCreate}，download=${counters.download}，delete=${counters.deleteFile}，同名节点=${entry.fake.duplicateTitles.length}，未实现端点=${entry.fake.unknownRoutes.length}`);
  }

  const failedScenarios = scenarioResults.filter((item) => !item.ok).length;
  if (failures.length > 0) {
    console.log(`\n${failedScenarios}/${scenarioResults.length} 个场景失败，另有全局问题 ${failures.length - failedScenarios} 个`);
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n全部 ${scenarioResults.length} 个场景通过`);
  }

  __setRequestUrlHandler(undefined);
}

process.on("unhandledRejection", (reason) => {
  uncaught.push(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  uncaught.push(`uncaughtException: ${error.stack ?? error.message}`);
});

main().catch((error) => {
  console.error("测试直接崩溃：", error);
  process.exitCode = 1;
});
