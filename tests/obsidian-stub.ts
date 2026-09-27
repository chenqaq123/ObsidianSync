/**
 * 离线端到端测试专用的 `obsidian` 替身模块。
 *
 * 只实现 `src/sync/**`、`src/feishu/**` 与 `src/ui/roundtrip-command.ts` 真正 import 到的成员：
 *   - `requestUrl`（client.ts 的 HTTP 出口，转交给可注入的 handler）
 *   - `TFile`（engine/executor/scanner 的 `instanceof` 判断）
 *   - `normalizePath`（log.ts）
 *   - `Notice` / `Modal` / `FuzzySuggestModal`（往返转换实测命令）
 * 其余名字（App / DataAdapter 等）在被测代码里都是 `import type`，编译期即被擦除。
 */

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
  json?: unknown;
}

export type RequestUrlHandler = (options: RequestUrlParam) => Promise<RequestUrlResponse>;

let handler: RequestUrlHandler | undefined;

/** 注入假飞书服务器；传 undefined 可卸载。 */
export function __setRequestUrlHandler(next: RequestUrlHandler | undefined): void {
  handler = next;
}

export async function requestUrl(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
  if (!handler) throw new Error("obsidian-stub: 还没有注入 requestUrl handler");
  const options: RequestUrlParam = typeof param === "string" ? { url: param } : param;
  const response = await handler(options);
  // 与真实 Obsidian 一致：throw=false 时把非 2xx 原样返回给调用方
  if (options.throw !== false && response.status >= 400) {
    throw new Error(`obsidian-stub: requestUrl 返回 HTTP ${response.status}（${options.url}）`);
  }
  return response;
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  stat: { size: number; mtime: number; ctime: number } = { size: 0, mtime: 0, ctime: 0 };
  parent: unknown = null;
  vault: unknown = null;
}

export function normalizePath(path: string): string {
  return path;
}

/** Notice / FuzzySuggestModal 只在「往返转换实测」命令里用到：测这条命令时才需要它们存在。 */
export class Notice {
  constructor(
    public message = "",
    public timeout?: number,
  ) {}

  setMessage(message: string): this {
    this.message = message;
    return this;
  }

  hide(): void {}
}

export class Modal {
  containerEl = {} as HTMLElement;

  constructor(public app: unknown) {}

  open(): void {}

  close(): void {}
}

export abstract class FuzzySuggestModal<T> extends Modal {
  private placeholder = "";

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  getPlaceholder(): string {
    return this.placeholder;
  }

  abstract getItems(): T[];

  abstract getItemText(item: T): string;

  abstract onChooseItem(item: T, event?: unknown): void;
}

// client.ts 的重试退避用了 window.setTimeout，Node 下补一个最小实现
const globalScope = globalThis as unknown as { window?: unknown };
if (!globalScope.window) {
  globalScope.window = { setTimeout, clearTimeout, setInterval, clearInterval };
}
