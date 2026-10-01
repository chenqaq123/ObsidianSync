import { requestUrl } from "obsidian";
import type { Logger } from "../log";

export const API_BASE = "https://open.feishu.cn";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Query = Record<string, string | number | boolean | undefined>;

const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991677, 20005]);
const RETRY_CODES = new Set([99991400, 1061045, 233523001]);
const MAX_ATTEMPTS = 4;
/** Obsidian 的 requestUrl 没有超时参数，被服务端挂住就永远不 resolve——给每个请求一个响应预算。 */
const REQUEST_TIMEOUT_MS = 60_000;
const SLOW_REQUEST_TIMEOUT_MS = 5 * 60_000;
const SLOW_PATH_PREFIX = "/open-apis/docs_ai/";

/** 超时是"结果不确定"的错误，multipart 上传不能重试（否则远端会多出重复文件）。 */
export class RequestTimeoutError extends Error {}

let budgetOverrideForTest: number | undefined;

/** 测试用：把响应预算压到很小，好在测试里复现"请求被服务端挂住"。 */
export function setRequestBudgetForTest(ms: number | undefined): void {
  budgetOverrideForTest = ms;
}

function requestBudget(path: string, multipart: boolean): number {
  if (budgetOverrideForTest !== undefined) return budgetOverrideForTest;
  return multipart || path.startsWith(SLOW_PATH_PREFIX) ? SLOW_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

export async function requestWithBudget(
  options: Parameters<typeof requestUrl>[0],
  budgetMs: number = budgetOverrideForTest ?? REQUEST_TIMEOUT_MS,
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestUrl(options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RequestTimeoutError(`超过 ${Math.round(budgetMs / 1000)} 秒没有响应`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
  log_id?: string;
}

export class FeishuError extends Error {
  readonly code: number;
  readonly status: number;
  readonly endpoint: string;
  readonly logId?: string;
  readonly authRelated: boolean;

  constructor(message: string, init: { code?: number; status?: number; endpoint: string; logId?: string }) {
    super(message);
    this.name = "FeishuError";
    this.code = init.code ?? -1;
    this.status = init.status ?? 0;
    this.endpoint = init.endpoint;
    this.logId = init.logId;
    this.authRelated = this.status === 401 || AUTH_CODES.has(this.code);
  }

  describe(): string {
    const parts = [this.message];
    if (this.code !== -1) parts.push(`code=${this.code}`);
    if (this.status) parts.push(`HTTP ${this.status}`);
    if (this.logId) parts.push(`log_id=${this.logId}`);
    return parts.join(" · ");
  }
}

export class FeishuAuthRequiredError extends Error {
  constructor(message = "飞书授权已失效，请在插件设置里重新授权") {
    super(message);
    this.name = "FeishuAuthRequiredError";
  }
}

export interface MultipartFile {
  name: string;
  data: ArrayBuffer;
}

export interface MultipartSpec {
  fields: Record<string, string>;
  file: MultipartFile;
}

interface RawResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
  payload?: FeishuEnvelope<unknown> & Record<string, unknown>;
}

export interface BinaryResponse {
  data: ArrayBuffer;
  headers: Record<string, string>;
  contentType?: string;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

export function pathSegment(segment: string): string {
  return encodeSegment(segment);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 头部参数（name / filename）里的引号会破坏分段，必须转义。 */
function escapeMultipartValue(value: string): string {
  return value.replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, " ");
}

/** 字段值按原样发（extra 这类值是 JSON，转义引号会让服务端解析失败），只去掉会破坏分段的换行。 */
function sanitizeMultipartFieldValue(value: string): string {
  return value.replace(/\r/g, "").replace(/\n/g, " ");
}

export function buildMultipart(spec: MultipartSpec): { body: ArrayBuffer; contentType: string } {
  const boundary = `----obsidianfeishu${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(spec.fields)) {
    chunks.push(
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n${sanitizeMultipartFieldValue(value)}\r\n`),
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeMultipartValue(spec.file.name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  chunks.push(new Uint8Array(spec.file.data));
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  return { body: concatChunks(chunks).buffer as ArrayBuffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function parseEnvelope(text: string): RawResponse["payload"] {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as RawResponse["payload"];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class FeishuClient {
  constructor(
    private readonly getToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly log: Logger,
  ) {}

  async json<T>(
    method: HttpMethod,
    path: string,
    options: { query?: Query; body?: unknown; multipart?: MultipartSpec } = {},
  ): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status >= 400 || (response.payload && response.payload.code !== 0)) {
      throw this.buildError(path, response);
    }
    const payload = response.payload as (FeishuEnvelope<T> & Record<string, unknown>) | undefined;
    if (!payload) {
      // 状态码正常但不是合法 JSON（网关页、被截断的响应等）不能当成"没有数据"，否则远端会被误判为空
      throw new FeishuError(`${path} 返回了非 JSON 响应（HTTP ${response.status}）：${(response.text || "").slice(0, 120)}`, {
        status: response.status,
        endpoint: path,
      });
    }
    return (payload.data ?? (payload as unknown as T)) as T;
  }

  async binary(path: string, query?: Query): Promise<ArrayBuffer> {
    return (await this.binaryResponse(path, query)).data;
  }

  /** 下载类请求需要 Content-Type / Content-Disposition 来推断扩展名（图片素材没有文件名）。 */
  async binaryResponse(path: string, query?: Query): Promise<BinaryResponse> {
    const response = await this.send("GET", path, { query });
    if (response.status < 200 || response.status >= 300) {
      throw this.buildError(path, response);
    }
    const payload = response.payload;
    if (payload && typeof payload.code === "number" && payload.code !== 0) {
      throw this.buildError(path, response);
    }
    const headers = response.headers ?? {};
    const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
    return { data: response.arrayBuffer, headers, contentType: contentTypeKey ? headers[contentTypeKey] : undefined };
  }

  private buildError(path: string, response: RawResponse): Error {
    const payload = response.payload;
    const code = typeof payload?.code === "number" ? payload.code : undefined;
    const message = (typeof payload?.msg === "string" && payload.msg) || (response.text || "").slice(0, 300) || "请求失败";
    return new FeishuError(`${path} 返回错误：${message}`, {
      code,
      status: response.status,
      endpoint: path,
      logId: typeof payload?.log_id === "string" ? payload.log_id : undefined,
    });
  }

  private async send(method: HttpMethod, path: string, options: { query?: Query; body?: unknown; multipart?: MultipartSpec }): Promise<RawResponse> {
    const url = buildUrl(path, options.query);
    let lastError: unknown;
    let refreshToken = false;
    // These POST endpoints only read data. All other writes can have committed before a timeout/5xx.
    const canRetryUncertain = method === "GET" || path.endsWith("/fetch") || path === "/open-apis/drive/v1/metas/batch_query";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let headers: Record<string, string>;
      let body: ArrayBuffer | string | undefined;
      try {
        headers = { Authorization: `Bearer ${await this.getToken(refreshToken)}` };
        refreshToken = false;
      } catch (error) {
        throw error;
      }

      if (options.multipart) {
        const built = buildMultipart(options.multipart);
        headers["Content-Type"] = built.contentType;
        body = built.body;
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(options.body);
      }

      try {
        const response = await requestWithBudget(
          { url, method, headers, body, throw: false },
          requestBudget(path, options.multipart !== undefined),
        );
        const raw: RawResponse = {
          status: response.status,
          text: response.text,
          arrayBuffer: response.arrayBuffer,
          headers: response.headers ?? {},
          payload: parseEnvelope(response.text),
        };

        const code = typeof raw.payload?.code === "number" ? raw.payload.code : undefined;
        const authRelated = raw.status === 401 || (code !== undefined && AUTH_CODES.has(code));
        if (authRelated && attempt < 2) {
          this.log.debug(`${path} 命中鉴权错误，刷新 token 后重试`);
          refreshToken = true;
          continue;
        }
        // 上传等有副作用的写请求不在"结果不确定"的错误上重试，避免远端留下重复文件
        const refusedRetry = raw.status === 429 || (code !== undefined && RETRY_CODES.has(code));
        const retryable = refusedRetry || (raw.status >= 500 && canRetryUncertain);
        if (retryable && attempt < MAX_ATTEMPTS) {
          const delay = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
          this.log.debug(`${path} 命中可重试错误（status=${raw.status} code=${code}），${delay}ms 后重试`);
          await sleep(delay);
          continue;
        }
        return raw;
      } catch (error) {
        lastError = error;
        // A disconnected write can already have committed, just like a timed-out write.
        if (!canRetryUncertain) {
          const message = error instanceof RequestTimeoutError ? "请求超时" : "写请求结果不确定";
          throw new FeishuError(`${path} ${message}：${String(error)}`, { endpoint: path });
        }
        if (canRetryUncertain && attempt < MAX_ATTEMPTS) {
          const delay = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
          this.log.debug(`${path} 网络异常，${delay}ms 后重试：${String(error)}`);
          await sleep(delay);
          continue;
        }
      }
    }

    throw new FeishuError(`${path} 请求失败：${String(lastError)}`, { endpoint: path });
  }
}
