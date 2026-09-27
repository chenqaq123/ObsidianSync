import type { App, DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";

const LOG_DIR = ".obsidian/feishu-sync";
const LOG_PATH = `${LOG_DIR}/sync.log`;
const MAX_LOG_BYTES = 256 * 1024;

/** 有 describe() 的错误（FeishuError）带上 code/HTTP/log_id，方便照着定位缺哪个权限。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & { describe?: () => string };
    return typeof candidate.describe === "function" ? candidate.describe() : error.message;
  }
  return String(error);
}

export class Logger {
  private pending: string[] = [];

  constructor(
    private readonly app: () => App,
    private readonly verbose: () => boolean,
  ) {}

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
    console.warn("[feishu-wiki-sync]", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
    console.error("[feishu-wiki-sync]", message);
  }

  debug(message: string): void {
    if (this.verbose()) this.write("DEBUG", message);
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${message}`;
    console.log("[feishu-wiki-sync]", line);
    if (this.verbose()) this.pending.push(line);
  }

  async flush(): Promise<void> {
    if (!this.verbose() || this.pending.length === 0) {
      this.pending = [];
      return;
    }
    const lines = this.pending;
    this.pending = [];
    const adapter = this.app().vault.adapter;
    try {
      await ensureFolder(adapter, LOG_DIR);
      const path = normalizePath(LOG_PATH);
      const existing = (await adapter.exists(path)) ? await adapter.read(path) : "";
      const merged = `${existing}${lines.join("\n")}\n`;
      await adapter.write(path, merged.length > MAX_LOG_BYTES ? merged.slice(merged.length - MAX_LOG_BYTES) : merged);
    } catch (error) {
      console.warn("[feishu-wiki-sync] failed to write log", error);
    }
  }
}

export async function ensureFolder(adapter: DataAdapter, folderPath: string): Promise<void> {
  const segments = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!(await adapter.exists(current))) {
      try {
        await adapter.mkdir(current);
      } catch (error) {
        if (!(await adapter.exists(current))) throw error;
      }
    }
  }
}
