import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { LocalNote } from "./types";
import { CONFLICT_DIR } from "./types";

export const ALWAYS_EXCLUDED = [".obsidian/**", ".trash/**", `${CONFLICT_DIR}/**`, "**/.DS_Store"];

export function assertSafeVaultPath(relPath: string): void {
  if (!relPath || /[\\\x00-\x1f:]/.test(relPath) || relPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`无效的仓库相对路径：${relPath}`);
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

export class PathFilter {
  private readonly patterns: RegExp[];

  constructor(userPatterns: string) {
    const raw = userPatterns
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => (line.endsWith("/") ? `${line}**` : line))
      .map((line) => line.replace(/^\.\//, "").replace(/^\//, ""));

    this.patterns = [...ALWAYS_EXCLUDED, ...raw].map(globToRegExp);
  }

  isExcluded(relPath: string): boolean {
    return this.patterns.some((pattern) => pattern.test(relPath));
  }
}

export function scanLocalNotes(app: App, filter: PathFilter): Map<string, LocalNote> {
  const notes = new Map<string, LocalNote>();
  for (const file of app.vault.getMarkdownFiles()) {
    if (filter.isExcluded(file.path)) continue;
    const stat = file.stat;
    notes.set(file.path, { relPath: file.path, size: stat?.size ?? 0, mtime: stat?.mtime ?? 0 });
  }
  return notes;
}

export async function readLocalBytes(app: App, relPath: string): Promise<ArrayBuffer> {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof TFile)) {
    throw new Error(`找不到本地文件：${relPath}`);
  }
  return app.vault.readBinary(file);
}

export function localStat(app: App, relPath: string): { size: number; mtime: number } {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof TFile)) return { size: 0, mtime: 0 };
  return { size: file.stat?.size ?? 0, mtime: file.stat?.mtime ?? 0 };
}

export async function writeLocalBytes(app: App, relPath: string, data: ArrayBuffer): Promise<void> {
  assertSafeVaultPath(relPath);
  const existing = app.vault.getAbstractFileByPath(relPath);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, data);
    return;
  }
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) {
    await app.vault.createFolder(dir).catch(() => undefined);
  }
  await app.vault.createBinary(relPath, data);
}
