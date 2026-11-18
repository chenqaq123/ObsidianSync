/**
 * 真实环境检查用的最小 Obsidian 垫片：把插件同一套引擎代码接到真实仓库目录与真实网络。
 * 只实现引擎链路用到的导出；UI 类（Modal/Notice 等）不在链路里，不提供。
 * parseYaml 只支持 frontmatter 的常见形态（标量 / 行内数组 / 块列表 / 简单嵌套），
 * 解析不了会抛错，规则按约定保留原文，不会猜。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder {
  path = "";
}

export interface RequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

/** 用 Node 的 fetch 实现 Obsidian 的 requestUrl（引擎链路里唯一的网络入口）。 */
export async function requestUrl(options: RequestUrlOptions): Promise<RequestUrlResponse> {
  const init: RequestInit = { method: options.method ?? "GET", headers: options.headers };
  if (options.body !== undefined) {
    init.body = typeof options.body === "string" ? options.body : new Uint8Array(options.body);
  }
  const response = await fetch(options.url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const arrayBuffer = await response.arrayBuffer();
  return { status: response.status, text: new TextDecoder().decode(arrayBuffer), arrayBuffer, headers };
}

interface YLine {
  indent: number;
  text: string;
}

export function parseYaml(text: string): unknown {
  const lines: YLine[] = [];
  for (const line of text.replace(/\t/g, "  ").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    lines.push({ indent: line.length - line.trimStart().length, text: trimmed });
  }
  if (lines.length === 0) return {};
  const parsed = parseNode(lines, 0, lines[0].indent);
  if (parsed.next !== lines.length) throw new Error("存在未消费的内容");
  return parsed.value;
}

function parseNode(lines: YLine[], start: number, indent: number): { value: unknown; next: number } {
  const line = lines[start];
  if (line.text === "-" || line.text.startsWith("- ")) return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

function parseMap(lines: YLine[], start: number, indent: number): { value: unknown; next: number } {
  const result: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length && lines[index].indent >= indent) {
    const line = lines[index];
    if (line.indent > indent) throw new Error(`无法解析的缩进：${line.text}`);
    const split = splitKey(line.text);
    if (!split) throw new Error(`无法解析的行：${line.text}`);
    const [key, rest] = split;
    if (rest === "") {
      index += 1;
      if (index < lines.length && lines[index].indent > indent) {
        const nested = parseNode(lines, index, lines[index].indent);
        result[key] = nested.value;
        index = nested.next;
      } else {
        result[key] = null;
      }
    } else {
      result[key] = parseScalar(rest);
      index += 1;
    }
  }
  return { value: result, next: index };
}

function parseList(lines: YLine[], start: number, indent: number): { value: unknown; next: number } {
  const result: unknown[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && (lines[index].text === "-" || lines[index].text.startsWith("- "))) {
    const itemText = lines[index].text === "-" ? "" : lines[index].text.slice(2).trim();
    if (itemText === "") {
      index += 1;
      if (index < lines.length && lines[index].indent > indent) {
        const nested = parseNode(lines, index, lines[index].indent);
        result.push(nested.value);
        index = nested.next;
      } else {
        result.push(null);
      }
    } else {
      const split = splitKey(itemText);
      if (split) {
        // `- key: value` 形式的列表项映射
        const entry: Record<string, unknown> = { [split[0]]: split[1] === "" ? null : parseScalar(split[1]) };
        index += 1;
        while (index < lines.length && lines[index].indent > indent && !lines[index].text.startsWith("- ") && splitKey(lines[index].text)) {
          const [key, rest] = splitKey(lines[index].text) as [string, string];
          entry[key] = rest === "" ? null : parseScalar(rest);
          index += 1;
        }
        result.push(entry);
      } else {
        result.push(parseScalar(itemText));
        index += 1;
      }
    }
  }
  return { value: result, next: index };
}

function splitKey(text: string): [string, string] | undefined {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ":" && !inSingle && !inDouble && (index === text.length - 1 || text[index + 1] === " ")) {
      const key = text.slice(0, index).trim().replace(/^["']|["']$/g, "");
      return [key, text.slice(index + 1).trim()];
    }
  }
  return undefined;
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitItems(inner).map((item) => parseScalar(item));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  if (value === "null" || value === "~" || value === "") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && index > 0 && value[index - 1] === " ") {
      return value.slice(0, index);
    }
  }
  return value;
}

function splitItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const char of inner) {
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "," && !inSingle && !inDouble) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** 把插件引擎接到真实仓库目录：vault/workspace/metadataCache 都按无编辑器、无链接缓存的形态工作。 */
export function createVaultApp(root: string) {
  const absolute = (rel: string): string => {
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`路径越出仓库：${rel}`);
    return resolved;
  };

  const makeTFile = (rel: string): TFile => {
    const stat = statSync(absolute(rel));
    const file = new TFile();
    file.path = rel.split(path.sep).join("/");
    file.name = path.basename(rel);
    file.extension = path.extname(rel).slice(1).toLowerCase();
    file.basename = path.basename(rel, path.extname(rel));
    file.stat = { ctime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size };
    return file;
  };

  const walkMarkdown = (): TFile[] => {
    const files: TFile[] = [];
    const visit = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path.join(dir, entry.name), childRel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(makeTFile(childRel));
      }
    };
    visit(root, "");
    return files;
  };

  const vault = {
    getName: () => path.basename(root),
    getMarkdownFiles: () => walkMarkdown(),
    getAbstractFileByPath: (rel: string): TFile | TFolder | null => {
      const stat = statSync(absolute(rel), { throwIfNoEntry: false });
      if (!stat) return null;
      if (stat.isDirectory()) {
        const folder = new TFolder();
        folder.path = rel.split(path.sep).join("/");
        return folder;
      }
      return makeTFile(rel);
    },
    read: async (file: TFile): Promise<string> => readFile(absolute(file.path), "utf8"),
    readBinary: async (file: TFile): Promise<ArrayBuffer> => {
      const buffer = await readFile(absolute(file.path));
      const bytes = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(bytes).set(buffer);
      return bytes;
    },
    createFolder: async (rel: string): Promise<void> => {
      await mkdir(absolute(rel), { recursive: true });
    },
    createBinary: async (rel: string, data: ArrayBuffer): Promise<void> => {
      const target = absolute(rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, new Uint8Array(data));
    },
    modifyBinary: async (file: TFile, data: ArrayBuffer): Promise<void> => {
      await writeFile(absolute(file.path), new Uint8Array(data));
    },
    adapter: {
      exists: async (rel: string): Promise<boolean> => existsSync(absolute(rel)),
      read: async (rel: string): Promise<string> => readFile(absolute(rel), "utf8"),
      write: async (rel: string, data: string): Promise<void> => {
        const target = absolute(rel);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data, "utf8");
      },
      mkdir: async (rel: string): Promise<void> => {
        mkdirSync(absolute(rel), { recursive: true });
      },
    },
  };

  return {
    vault,
    workspace: { getLeavesOfType: () => [] },
    metadataCache: { getFirstLinkpathDest: () => null },
  };
}
