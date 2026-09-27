import type { FeishuClient } from "./client";
import { FeishuError, pathSegment } from "./client";
import type { DocNewBlock } from "./docImages";
import { readNewBlocks, readRevisionId } from "./docImages";
import { encodeFeishuMath } from "../convert/markdown";

/**
 * docs_ai 接口：新版文档（docx）与 Markdown 的互转。请求形状照抄官方 CLI
 * （github.com/larksuite/cli，shortcuts/doc/*.go）：
 *   - 创建 POST /open-apis/docs_ai/v1/documents                  （docs_create_v2.go buildCreateBody）
 *   - 更新 PUT  /open-apis/docs_ai/v1/documents/{document_id}    （docs_update_v2.go buildUpdateBodyBase）
 *   - 取回 POST /open-apis/docs_ai/v1/documents/{token}/fetch    （docs_fetch_v2.go buildFetchBody）
 *   - 异步 GET  /open-apis/docs_ai/v1/async_tasks/{task_id}      （docs_create_async.go）
 */

/** extra_param 是 JSON 字符串而不是对象；open_create_async 让服务端返回 task_id 走异步轮询。 */
const CREATE_EXTRA_PARAM = '{"open_create_async":true}';
/** 与官方 CLI 的 fetch 默认值一致（docs_fetch_v2.go 的 docsFetchCommentsExtraParam）。 */
const FETCH_EXTRA_PARAM = '{"enable_user_cite_reference_map":true,"include_comments":true,"return_html5_block_data":true}';

const ASYNC_MAX_WAIT_MS = 10 * 60 * 1000;
const ASYNC_DEFAULT_POLL_MS = 3000;
const ASYNC_MIN_POLL_MS = 100;
const ASYNC_MAX_POLL_MS = 10_000;

export interface CreatedDocument {
  documentId: string;
  url?: string;
  /** 本地图片占位块（block_token 是 @lcli_img_ 标记），图片上传/绑定要用 */
  newBlocks: DocNewBlock[];
  revisionId?: number;
}

export interface UpdatedDocument {
  newBlocks: DocNewBlock[];
  revisionId?: number;
}

export interface CreateDocumentOptions {
  title: string;
  markdown: string;
  parentToken?: string;
  onProgress?: (message: string) => void;
}

export interface UpdateDocumentOptions {
  title: string;
  markdown: string;
  /**
   * 是否把 <title> 放到 content 最前面。默认开：CLI 的 +create 会加标题标签而 +update 没有 --title，
   * 这里让两条路径的 content 完全一致，「相同内容再更新一次」才真的是相同内容。
   */
  includeTitle?: boolean;
}

interface AsyncTask {
  task_id?: string;
  status?: string;
  stage?: string;
  poll_after_ms?: number;
  result?: { create_document?: string };
  failure?: { code?: string; message?: string };
}

interface DocsDocumentData {
  document?: { document_id?: string; url?: string; new_blocks?: unknown; revision_id?: unknown };
  document_id?: string;
  url?: string;
  task?: AsyncTask;
  result?: unknown;
  warnings?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function escapeTitleText(title: string): string {
  // 与 Go 的 xml.EscapeText 对齐（CLI 的 escapeDocTitleText 用的就是它）
  return title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

/**
 * markdown 格式下标题也要写在 content 最前面（DocxXML 的 <title>），
 * 与 CLI 的 buildCreateContentWithBody 一致。
 */
export function buildMarkdownContent(title: string, markdown: string): string {
  const tag = `<title>${escapeTitleText(title.trim())}</title>`;
  return markdown === "" ? tag : `${tag}\n${encodeFeishuMath(markdown)}`;
}

function warningsText(data: Record<string, unknown> | undefined): string {
  const warnings = data?.warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  return `；服务端 warnings：${warnings.map((item) => String(item)).join(" / ")}`;
}

/** docs_ai 会用 code=0 + result="failed" 表示业务失败（CLI 的 docsAPIOperationFailed）。 */
function assertOperationSucceeded(endpoint: string, data: Record<string, unknown> | undefined): void {
  if (typeof data?.result === "string" && data.result.toLowerCase() === "failed") {
    throw new FeishuError(`docs_ai ${endpoint} 返回 result=failed${warningsText(data)}`, { endpoint });
  }
}

function pollInterval(pollAfterMs: number | undefined): number {
  if (!pollAfterMs || pollAfterMs <= 0) return ASYNC_DEFAULT_POLL_MS;
  return Math.min(ASYNC_MAX_POLL_MS, Math.max(ASYNC_MIN_POLL_MS, pollAfterMs));
}

function decodeTaskResult(endpoint: string, task: AsyncTask): DocsDocumentData {
  const raw = task.result?.create_document;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FeishuError(`docs_ai ${endpoint} 的异步任务成功但缺少 result.create_document`, { endpoint });
  }
  try {
    const parsed = JSON.parse(raw) as DocsDocumentData;
    if (!parsed || typeof parsed !== "object") throw new Error("不是 JSON 对象");
    return parsed;
  } catch (error) {
    throw new FeishuError(`docs_ai ${endpoint} 的 result.create_document 不是合法 JSON：${String(error)}`, { endpoint });
  }
}

async function waitForAsyncTask(
  client: FeishuClient,
  task: AsyncTask,
  options: { endpoint: string; onProgress?: (message: string) => void },
): Promise<DocsDocumentData> {
  const taskId = (task.task_id ?? "").trim();
  if (!taskId) {
    throw new FeishuError(`docs_ai ${options.endpoint} 返回了没有 task_id 的异步任务`, { endpoint: options.endpoint });
  }
  const path = `/open-apis/docs_ai/v1/async_tasks/${pathSegment(taskId)}`;
  const deadline = Date.now() + ASYNC_MAX_WAIT_MS;
  let current = task;
  // 该端点服务端会挂住等一会儿，第一次查询不用先 sleep
  let delay = 0;
  let polls = 0;

  for (;;) {
    const status = (current.status ?? "").trim().toLowerCase();
    if (status === "succeeded") return decodeTaskResult(options.endpoint, current);
    if (status === "failed" || status === "expired") {
      const code = current.failure?.code ? `（code: ${current.failure.code}）` : "";
      const message = current.failure?.message || status;
      throw new FeishuError(`docs_ai 文档处理失败：${message}${code}`, { endpoint: path });
    }
    if (status !== "" && status !== "processing") {
      throw new FeishuError(`docs_ai ${path} 返回了未知任务状态 ${current.status}`, { endpoint: path });
    }
    if (Date.now() >= deadline) {
      throw new FeishuError(`docs_ai 等待文档处理超过 ${Math.round(ASYNC_MAX_WAIT_MS / 60000)} 分钟，请稍后用「取回」重试`, {
        endpoint: path,
      });
    }
    if (delay > 0) await sleep(delay);

    polls += 1;
    options.onProgress?.(`等待飞书处理文档（第 ${polls} 次轮询）…`);
    const data = await client.json<{ task?: AsyncTask }>("GET", path);
    const next = data?.task;
    if (!next) throw new FeishuError(`docs_ai ${path} 的响应里没有 task`, { endpoint: path });
    const returnedId = (next.task_id ?? "").trim();
    if (returnedId && returnedId !== taskId) {
      throw new FeishuError(`docs_ai ${path} 返回的 task_id 与请求不一致`, { endpoint: path });
    }
    current = next;
    delay = pollInterval(current.poll_after_ms);
  }
}

/**
 * 用 Markdown 新建一篇 docx 文档。服务端可能返回 task_id 走异步，这里轮询到完成为止。
 * 注意：本函数不会上传本地图片，markdown 里的图片引用会原样发给服务端。
 */
export async function createDocumentFromMarkdown(
  client: FeishuClient,
  options: CreateDocumentOptions,
): Promise<CreatedDocument> {
  const title = options.title.trim();
  if (!title) throw new Error("创建文档需要非空标题");
  const path = "/open-apis/docs_ai/v1/documents";
  const body: Record<string, unknown> = {
    format: "markdown",
    content: buildMarkdownContent(title, options.markdown),
    extra_param: CREATE_EXTRA_PARAM,
  };
  if (options.parentToken) body.parent_token = options.parentToken;

  options.onProgress?.("创建飞书文档…");
  const initial = await client.json<DocsDocumentData>("POST", path, { body });
  assertOperationSucceeded(path, initial as Record<string, unknown>);

  const taskId = (initial?.task?.task_id ?? "").trim();
  const ready = taskId ? await waitForAsyncTask(client, initial.task as AsyncTask, { endpoint: path, onProgress: options.onProgress }) : initial;
  assertOperationSucceeded(path, ready as Record<string, unknown>);

  const created = ready?.document as Record<string, unknown> | undefined;
  const asRecord = ready as unknown as Record<string, unknown>;
  const documentId = readString(created, "document_id") ?? readString(asRecord, "document_id");
  if (!documentId) {
    throw new FeishuError(`docs_ai 创建文档成功但没有返回 document_id`, { endpoint: path });
  }
  return {
    documentId,
    url: readString(created, "url") ?? readString(asRecord, "url"),
    newBlocks: readNewBlocks(ready),
    revisionId: readRevisionId(ready),
  };
}

/** 原位覆盖更新（command=overwrite，revision_id=-1 表示最新版本）。 */
export async function updateDocumentFromMarkdown(
  client: FeishuClient,
  documentId: string,
  options: UpdateDocumentOptions,
): Promise<UpdatedDocument> {
  const id = documentId.trim();
  if (!id) throw new Error("更新文档需要 document_id");
  const path = `/open-apis/docs_ai/v1/documents/${pathSegment(id)}`;
  const content = options.includeTitle === false ? encodeFeishuMath(options.markdown) : buildMarkdownContent(options.title, options.markdown);
  // 按 CLI 的 buildUpdateBodyBase：format + command + revision_id + content，没有 extra_param
  const data = await client.json<Record<string, unknown>>("PUT", path, {
    body: { format: "markdown", command: "overwrite", revision_id: -1, content },
  });
  assertOperationSucceeded(path, data);
  return { newBlocks: readNewBlocks(data), revisionId: readRevisionId(data) };
}

/** 把远端文档取回成 Markdown。 */
export async function fetchDocumentMarkdown(client: FeishuClient, documentId: string): Promise<string> {
  const id = documentId.trim();
  if (!id) throw new Error("取回文档需要 document_id");
  const path = `/open-apis/docs_ai/v1/documents/${pathSegment(id)}/fetch`;
  const data = await client.json<DocsDocumentData>("POST", path, {
    body: {
      format: "markdown",
      extra_param: FETCH_EXTRA_PARAM,
      // CLI 默认 --detail simple：不导出 block id / 样式属性
      export_option: { export_block_id: false, export_style_attrs: false, export_cite_extra_data: false },
    },
  });
  const content = (data?.document as Record<string, unknown> | undefined)?.content;
  if (typeof content !== "string") {
    throw new FeishuError(`docs_ai 取回文档 ${id} 的响应里没有 document.content`, { endpoint: path });
  }
  return content;
}
