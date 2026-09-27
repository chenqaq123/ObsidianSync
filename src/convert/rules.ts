import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import { newImageMarker } from "../feishu/docImages";
import type { Logger } from "../log";
import { ensureFolder } from "../log";

/**
 * 文档模式的可编辑转换规则。规则本身是纯函数（字符串进、字符串出），
 * 开关与说明存在 vault 里的 rules.json，与内置默认按 id 合并。
 */

export type RuleDirection = "toFeishu" | "toObsidian";

export const RULES_PATH = ".obsidian/feishu-sync/rules.json";
export const RULES_VERSION = 1;

export interface RuleContext {
  relPath: string;
  /** 文档标题（笔记名去掉 .md） */
  documentTitle: string;
  /** 本地当前内容，drop-title-heading 需要它判断本地是否本来就有同名 H1 */
  localContent: string;
  /** 上行：把 vault 内图片引用解析成真实文件（拿不到就保持原样） */
  resolveImage?: (linkpath: string, sourcePath: string) => ResolvedImage | undefined;
  /** 上行：image-upload 把引用换成的占位标记与文件，执行器读它去上传/绑定 */
  imageUploads?: LocalImageUpload[];
  /** 下行：远程图片引用原文 → 本地 vault 路径（执行器下载好再交给规则改写） */
  imageDownloads?: Map<string, string>;
  /** 下行：附件链接写法。shortest = 只写文件名（与 Obsidian「最短路径」一致），path = 带附件目录前缀 */
  attachmentLinkStyle?: "shortest" | "path";
  /** 规则跳过/降级的原因，执行器会写进报告与日志 */
  warnings?: string[];
}

export interface ResolvedImage {
  path: string;
  size: number;
}

export interface LocalImageUpload {
  /** 原始引用文本 */
  raw: string;
  /** 官方标记：@lcli_img_ + 32 位 hex */
  marker: string;
  vaultPath: string;
  fileName: string;
  size: number;
}

export interface RemoteImageRef {
  /** 取回内容里的引用原文 */
  raw: string;
  url: string;
  /** 从 URL 里能抽出的飞书素材 token；抽不到就没有 */
  token?: string;
  alt: string;
  index: number;
}

export interface BuiltInRule {
  id: string;
  description: string;
  defaultEnabled: boolean;
  apply: (input: string, ctx: RuleContext) => string;
}

export interface RuleEntry {
  id: string;
  enabled: boolean;
  description: string;
}

export interface RulesFile {
  version: number;
  toFeishu: RuleEntry[];
  toObsidian: RuleEntry[];
}

const IMAGE_LINK = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const FENCE = /^\s*(```|~~~)/;

const WIKI_IMAGE = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const XML_IMAGE = /<img\b[^>]*\/?>/gi;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 逐行处理，跳过围栏代码块内部（代码里的示例不该被改写）。 */
function mapOutsideFences(text: string, transform: (line: string) => string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : transform(line);
    })
    .join("\n");
}

const imageRefNormalize: BuiltInRule = {
  id: "image-ref-normalize",
  description:
    "上行：把标准 Markdown 图片 ![alt](相对路径) 换成 Obsidian 的 ![[相对路径]]。实测标准图片引用会被飞书整行丢弃，![[...]] 能原样保留。http(s) 图片地址不改。",
  defaultEnabled: true,
  apply: (input) =>
    mapOutsideFences(input, (line) =>
      line.replace(IMAGE_LINK, (raw, target: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? raw : `![[${target}]]`)),
    ),
};

const tabIndentToSpaces: BuiltInRule = {
  id: "tab-indent-to-spaces",
  description:
    "上行：行首 Tab 按 2 空格换算。实测飞书会把 Tab 缩进规范成空格，先转过来能减少「发出 vs 取回」的无谓差异。围栏代码块内部不动。",
  defaultEnabled: true,
  apply: (input) =>
    mapOutsideFences(input, (line) => {
      const match = /^[\t ]+/.exec(line);
      if (!match || !match[0].includes("\t")) return line;
      return match[0].replace(/\t/g, "  ") + line.slice(match[0].length);
    }),
};

const MATH_FENCE = /^\s*(```+|~~~+)/;
const MATH_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const MATH_TABLE_ROW = /^\s*\|/;
/** 缩进、引用块、标题这类结构行里的公式不拆——硬拆会把公式挪到结构外，反而毁掉原文。 */
const MATH_STRUCTURED_LINE = /^(?:[\t ]|>|#{1,6}\s)/;

/** pos 处的字符是否被反斜杠转义（前面连续反斜杠为奇数个）。 */
function isEscapedAt(text: string, pos: number): boolean {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** 从 from 起找下一个未被转义的 token，找不到返回 -1。 */
function findUnescaped(text: string, token: string, from: number): number {
  let index = text.indexOf(token, from);
  while (index !== -1 && isEscapedAt(text, index)) index = text.indexOf(token, index + 1);
  return index;
}

/** 跳过一段行内代码（含定界反引号），返回结束位置。 */
function inlineCodeEnd(line: string, from: number): number {
  const ticks = /^`+/.exec(line.slice(from))?.[0] ?? "`";
  const close = line.indexOf(ticks, from + ticks.length);
  return close === -1 ? line.length : close + ticks.length;
}

/** 一行里未被行内代码包裹、也未被转义的 $$ 位置。 */
function blockDelimPositions(line: string): number[] {
  const positions: number[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      i = inlineCodeEnd(line, i);
      continue;
    }
    if (line.startsWith("$$", i) && !isEscapedAt(line, i)) {
      positions.push(i);
      i += 2;
      continue;
    }
    i += 1;
  }
  return positions;
}

/**
 * 逐字符扫描，只在数学环境内部调用 rewrite。跳过围栏代码块与行内代码；
 * $$ 公式允许跨行，$ 行内公式不跨行。
 */
function rewriteMathBodies(input: string, rewrite: (body: string) => string): string {
  let out = "";
  let i = 0;
  let fenced: string | undefined;
  let inBlockMath = false;
  while (i < input.length) {
    if (!inBlockMath && (i === 0 || input[i - 1] === "\n")) {
      const lineEnd = input.indexOf("\n", i);
      const end = lineEnd === -1 ? input.length : lineEnd;
      const fence = MATH_FENCE.exec(input.slice(i, end))?.[1];
      if (fence) {
        if (!fenced) fenced = fence;
        else if (fence[0] === fenced[0] && fence.length >= fenced.length) fenced = undefined;
      }
      if (fence || fenced) {
        out += input.slice(i, end);
        i = end;
        continue;
      }
    }
    if (inBlockMath) {
      const close = findUnescaped(input, "$$", i);
      out += rewrite(input.slice(i, close === -1 ? input.length : close));
      if (close === -1) {
        i = input.length;
        continue;
      }
      out += "$$";
      i = close + 2;
      inBlockMath = false;
      continue;
    }
    if (input[i] === "`") {
      const end = inlineCodeEnd(input, i);
      out += input.slice(i, end);
      i = end;
      continue;
    }
    if (input.startsWith("$$", i) && !isEscapedAt(input, i)) {
      inBlockMath = true;
      out += "$$";
      i += 2;
      continue;
    }
    if (input[i] === "$" && !isEscapedAt(input, i)) {
      const lineEnd = input.indexOf("\n", i);
      const close = findUnescaped(input, "$", i + 1);
      if (close > i + 1 && (lineEnd === -1 || close < lineEnd)) {
        out += `$${rewrite(input.slice(i + 1, close))}$`;
        i = close + 1;
        continue;
      }
    }
    out += input[i];
    i += 1;
  }
  return out;
}

const mathEscapeHash: BuiltInRule = {
  id: "math-escape-hash",
  description:
    "上行：数学环境里的裸 # 写成 \\#。飞书与 MathJax 都把 # 当宏参数符，公式里留未转义的 #（如 $URL = path#fragment$）会让整条公式渲染失败。围栏代码块与行内代码内不动，跨行的 $$ 公式同样处理。",
  defaultEnabled: true,
  apply: (input) => rewriteMathBodies(input, (body) => body.replace(/\\#|#/g, "\\#")),
};

const blockFormulaOwnParagraph: BuiltInRule = {
  id: "block-formula-own-paragraph",
  description:
    "上行：让块级公式 $$...$$ 独占一个段落，前后各留一个空行，与正文同处一行时按段落拆开——飞书只有拿到独立段落才会渲染成居中的块级公式，" +
    "混在文字行里会被当成行内内容。列表项、表格、缩进行里的公式不动（原因写进报告），围栏代码块内不动。",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const lines = input.split("\n");
    const out: string[] = [];
    let fenced: string | undefined;
    let index = 0;
    let blankAfter = false;

    const pushBlank = (): void => {
      if (out.length === 0) return;
      if ((out[out.length - 1] ?? "").trim() === "") return;
      out.push("");
    };

    while (index < lines.length) {
      const line = lines[index];
      if (blankAfter && line.trim() !== "") {
        pushBlank();
        blankAfter = false;
      }
      const fence = MATH_FENCE.exec(line)?.[1];
      if (fence) {
        if (!fenced) fenced = fence;
        else if (fence[0] === fenced[0] && fence.length >= fenced.length) fenced = undefined;
      }
      if (fence || fenced) {
        out.push(line);
        index += 1;
        continue;
      }

      const positions = blockDelimPositions(line);
      if (positions.length === 0) {
        out.push(line);
        index += 1;
        continue;
      }
      if (MATH_STRUCTURED_LINE.test(line) || MATH_LIST_ITEM.test(line) || MATH_TABLE_ROW.test(line)) {
        ctx.warnings?.push(`第 ${index + 1} 行的块级公式在缩进/列表项/表格/引用/标题里，未拆成独立段落`);
        out.push(line);
        index += 1;
        continue;
      }

      const open = positions[0];
      let closeLine = index;
      let close = positions.length >= 2 ? positions[1] : -1;
      if (close < 0) {
        for (let scan = index + 1; scan < lines.length; scan += 1) {
          const found = blockDelimPositions(lines[scan]);
          if (found.length > 0) {
            closeLine = scan;
            close = found[0];
            break;
          }
        }
      }
      if (close < 0) {
        out.push(line);
        index += 1;
        continue;
      }

      const before = line.slice(0, open).trimEnd();
      const formulaLines =
        closeLine === index
          ? [line.slice(open, close + 2)]
          : [line.slice(open), ...lines.slice(index + 1, closeLine), lines[closeLine].slice(0, close + 2)];
      const after = (closeLine === index ? line.slice(close + 2) : lines[closeLine].slice(close + 2)).trimStart();

      if (before !== "") out.push(before);
      pushBlank();
      for (const formulaLine of formulaLines) out.push(formulaLine);
      blankAfter = true;

      if (after !== "") {
        lines[closeLine] = after;
        index = closeLine;
        continue;
      }
      index = closeLine + 1;
    }
    return out.join("\n");
  },
};

const footnoteDowngrade: BuiltInRule = {
  id: "footnote-downgrade",
  description:
    "上行：脚注降级成普通文本——引用标记 [^x] 删掉，定义行 [^x]: 正文 变成「脚注 x：正文」。实测飞书会丢掉脚注，默认关闭：关着时脚注会原样发出去（飞书侧仍会丢），开着则至少正文能留在飞书里，但回写时无法还原成脚注语法。",
  defaultEnabled: false,
  apply: (input) => {
    const definitions = new Set<string>();
    for (const line of input.split("\n")) {
      const match = /^\[\^([^\]]+)\]:/.exec(line);
      if (match) definitions.add(match[1]);
    }
    return input
      .split("\n")
      .map((line) => {
        const definition = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
        if (definition) return `脚注 ${definition[1]}：${definition[2]}`;
        return line.replace(/\[\^([^\]]+)\]/g, (raw, id: string) => (definitions.has(id) ? "" : raw));
      })
      .join("\n");
  },
};

const dropTitleHeading: BuiltInRule = {
  id: "drop-title-heading",
  description:
    "下行：取回内容首行若是「# 文档标题」就删掉——飞书把 <title> 取回成了首行 H1，直接写回会把标题当正文复制进笔记。本地现有内容本来就以这行开头时保留（说明标题本来就是笔记正文的一部分）。",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const title = ctx.documentTitle.trim();
    if (!title) return input;
    const heading = `# ${title}`;
    const lines = input.split("\n");
    if ((lines[0] ?? "").trim() !== heading) return input;
    if ((ctx.localContent.split("\n")[0] ?? "").trim() === heading) return input;
    const rest = lines.slice(1);
    if (rest.length > 0 && rest[0].trim() === "") rest.shift();
    return rest.join("\n");
  },
};

const restoreImageRef: BuiltInRule = {
  id: "restore-image-ref",
  description:
    "下行：把飞书侧的图片还原成标准 Markdown 图片引用。等图片上传链路（medias/upload_all + reference_map）做好后再启用，现在打开也是空操作。",
  defaultEnabled: false,
  apply: (input) => input,
};

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;");
}

function isLocalImageTarget(target: string): boolean {
  const value = target.trim();
  if (!value) return false;
  if (HAS_SCHEME.test(value)) return false;
  return true;
}

/** 上行：本地图片引用 → 官方占位标记（<img path="@lcli_img_…"/>），标记由服务端关联回块。 */
function rewriteLocalImageLine(line: string, ctx: RuleContext): string {
  const resolve = ctx.resolveImage;
  const uploads = ctx.imageUploads;
  if (!resolve || !uploads) return line;

  const replaceWith = (raw: string, target: string, caption: string): string => {
    if (!isLocalImageTarget(target)) return raw;
    const linkpath = target.trim().replace(/^<|>$/g, "");
    const resolved = resolve(linkpath, ctx.relPath);
    if (!resolved) {
      ctx.warnings?.push(`图片 ${linkpath} 在 vault 里找不到，已原样保留`);
      return raw;
    }
    const marker = newImageMarker();
    uploads.push({
      raw,
      marker,
      vaultPath: resolved.path,
      fileName: linkpath.split("/").filter(Boolean).pop() ?? "image",
      size: resolved.size,
    });
    const captionAttr = caption.trim() ? ` caption="${escapeXmlAttr(caption.trim())}"` : "";
    return `<img path="${marker}"${captionAttr}/>`;
  };

  let out = line
    .replace(WIKI_IMAGE, (raw: string, linkpath: string) => replaceWith(raw, linkpath, ""))
    .replace(MARKDOWN_IMAGE, (raw: string, alt: string, target: string) => replaceWith(raw, target, alt));
  return out;
}

const imageUpload: BuiltInRule = {
  id: "image-upload",
  description:
    "上行：把 vault 内的本地图片（![[x.png]] 或 ![alt](attachments/x.png)）换成官方的占位标记，建/更新文档后上传素材并绑定成真正的图片块。" +
    "需要 docs:document.media:upload 权限；http(s) 外链与 vault 里找不到的文件保持原样（会在报告里列出）。",
  defaultEnabled: true,
  apply: (input, ctx) => mapOutsideFences(input, (line) => rewriteLocalImageLine(line, ctx)),
};

/**
 * 从飞书图片 URL 里抽素材 token。
 * 实测（真机，2026-09）markdown 取回时图片是 `![](https://feishu.cn/file/<token>)`，
 * 而该 token 可直接用于 `GET /open-apis/drive/v1/medias/{token}/download`。
 */
export function extractMediaToken(rawUrl: string): string | undefined {
  let url = rawUrl.trim();
  try {
    url = decodeURIComponent(url);
  } catch {
    // 保留原样
  }
  const patterns = [
    /\/file\/([A-Za-z0-9_-]+)/,
    /\/medias\/([A-Za-z0-9_-]+)\/(?:download|preview_download)/,
    /[?&]file_token=([A-Za-z0-9_-]+)/,
    /\/medias\/([A-Za-z0-9_-]+)(?:[?#/]|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** 取回内容里的图片引用（Markdown 形态为主，兼容残留的 <img> 标签）。 */
export function collectRemoteImages(content: string): RemoteImageRef[] {
  const refs: RemoteImageRef[] = [];
  const lines = content.split("\n");
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    MARKDOWN_IMAGE.lastIndex = 0;
    let match = MARKDOWN_IMAGE.exec(line);
    while (match) {
      const url = match[2];
      refs.push({ raw: match[0], url, token: extractMediaToken(url), alt: match[1], index: refs.length });
      match = MARKDOWN_IMAGE.exec(line);
    }
    XML_IMAGE.lastIndex = 0;
    let xml = XML_IMAGE.exec(line);
    while (xml) {
      const tag = xml[0];
      const url = /(?:href|src|url)="([^"]*)"/.exec(tag)?.[1] ?? "";
      const token = /token="([^"]*)"/.exec(tag)?.[1] ?? (url ? extractMediaToken(url) : undefined);
      if (url || token) {
        const alt = /(?:caption|alt)="([^"]*)"/.exec(tag)?.[1] ?? "";
        refs.push({ raw: tag, url, token: token || undefined, alt, index: refs.length });
      }
      xml = XML_IMAGE.exec(line);
    }
  }
  return refs;
}

/** 把带素材 token 的图片 URL 换成稳定形态，用于算远端基线哈希。 */
export function normalizeRemoteImageUrls(content: string): string {
  let out = content;
  for (const ref of collectRemoteImages(content)) {
    if (!ref.token) continue;
    out = out.split(ref.raw).join(ref.raw.replace(ref.url, `media:${ref.token}`));
  }
  return out;
}

const unescapeImageMarkup: BuiltInRule = {
  id: "unescape-image-markup",
  description:
    "下行：飞书把它解析不了的图片引用转义成 !\\[\\](路径) 这样的形态，直接写回本地会变成渲染不出来的坏引用。这条规则把图片引用里的转义方括号还原（只处理图片语法，不动普通链接与正文）。",
  defaultEnabled: true,
  apply: (input) =>
    input
      .replace(/!\\\[\\\[([^\]]*?)\\\]\\\]/g, "![[$1]]")
      .replace(/!\\\[\\\]\(/g, "![]("),
};

const imageDownload: BuiltInRule = {
  id: "image-download",
  description:
    "下行：把取回内容里的飞书图片下载到本地附件目录，并把引用改写成 ![[附件目录/文件名]]。" +
    "需要 docs:document.media:download 权限；下载失败时保留原始引用并在报告里说明，不会让整次拉取失败。",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const downloads = ctx.imageDownloads;
    if (!downloads || downloads.size === 0) return input;
    let out = input;
    for (const [raw, localPath] of downloads) {
      if (!localPath) continue;
      const target = ctx.attachmentLinkStyle === "path" ? localPath : localPath.split("/").pop() ?? localPath;
      out = out.split(raw).join(`![[${target}]]`);
    }
    return out;
  },
};

export const BUILT_IN_RULES: Record<RuleDirection, BuiltInRule[]> = {
  toFeishu: [imageRefNormalize, tabIndentToSpaces, mathEscapeHash, blockFormulaOwnParagraph, footnoteDowngrade, imageUpload],
  toObsidian: [unescapeImageMarkup, dropTitleHeading, imageDownload, restoreImageRef],
};

function entryOf(rule: BuiltInRule): RuleEntry {
  return { id: rule.id, enabled: rule.defaultEnabled, description: rule.description };
}

export function defaultRulesFile(): RulesFile {
  return {
    version: RULES_VERSION,
    toFeishu: BUILT_IN_RULES.toFeishu.map(entryOf),
    toObsidian: BUILT_IN_RULES.toObsidian.map(entryOf),
  };
}

function mergeDirection(direction: RuleDirection, raw: unknown, warnings: string[]): RuleEntry[] {
  const builtIns = BUILT_IN_RULES[direction];
  const byId = new Map(builtIns.map((rule) => [rule.id, rule]));
  const merged: RuleEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id : "";
      if (!id) continue;
      const builtIn = byId.get(id);
      if (!builtIn) {
        warnings.push(`规则文件里 ${direction} 的 "${id}" 不是内置规则，已忽略`);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const enabled = typeof (item as { enabled?: unknown }).enabled === "boolean" ? (item as { enabled: boolean }).enabled : builtIn.defaultEnabled;
      merged.push({ id, enabled, description: builtIn.description });
    }
  }
  for (const rule of builtIns) {
    if (seen.has(rule.id)) continue;
    warnings.push(`规则文件里 ${direction} 缺少 "${rule.id}"，已按默认值（${rule.defaultEnabled ? "开" : "关"}）补上`);
    merged.push(entryOf(rule));
  }
  return merged;
}

export function mergeRulesFile(raw: unknown, warnings: string[] = []): RulesFile {
  const source = (raw ?? {}) as { toFeishu?: unknown; toObsidian?: unknown; version?: unknown };
  return {
    version: typeof source.version === "number" ? source.version : RULES_VERSION,
    toFeishu: mergeDirection("toFeishu", source.toFeishu, warnings),
    toObsidian: mergeDirection("toObsidian", source.toObsidian, warnings),
  };
}

export function parseRulesFile(text: string, warnings: string[] = []): RulesFile {
  return mergeRulesFile(JSON.parse(text) as unknown, warnings);
}

export async function writeRulesFile(adapter: DataAdapter, rules: RulesFile): Promise<void> {
  const path = normalizePath(RULES_PATH);
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await ensureFolder(adapter, dir);
  await adapter.write(path, `${JSON.stringify(rules, null, 2)}\n`);
}

/** 文件不存在就写一份完整默认；存在但读不动/不是合法 JSON 时只用默认值，不动用户的文件。 */
export async function loadRules(adapter: DataAdapter, logger?: Logger): Promise<RulesFile> {
  const path = normalizePath(RULES_PATH);
  if (!(await adapter.exists(path))) {
    const rules = defaultRulesFile();
    try {
      await writeRulesFile(adapter, rules);
      logger?.info(`已写入默认转换规则：${RULES_PATH}`);
    } catch (error) {
      logger?.warn(`写入默认转换规则失败（继续用内置默认值）：${String(error)}`);
    }
    return rules;
  }
  try {
    const warnings: string[] = [];
    const rules = parseRulesFile(await adapter.read(path), warnings);
    for (const warning of warnings) logger?.warn(`转换规则：${warning}`);
    return rules;
  } catch (error) {
    logger?.warn(`转换规则文件无法解析，本次使用内置默认值（文件未改动）：${String(error)}`);
    return defaultRulesFile();
  }
}

export function applyRules(direction: RuleDirection, input: string, ctx: RuleContext, rules: RulesFile): string {
  const enabled = new Set(rules[direction].filter((entry) => entry.enabled).map((entry) => entry.id));
  let output = input;
  for (const rule of BUILT_IN_RULES[direction]) {
    if (!enabled.has(rule.id)) continue;
    output = rule.apply(output, ctx);
  }
  return output;
}

/**
 * 只改排版、且没有对应下行还原规则的上行规则。它们的输出形态会被飞书固化，
 * 取回时天然与本地原文不同——拉取前用 sameAfterCosmeticRules 判定，差异只来自这里就不回写本地。
 */
export const COSMETIC_PUBLISH_RULE_IDS = ["math-escape-hash", "block-formula-own-paragraph"];

/** 只跑上面那批排版规则，两侧结果相同即说明差异纯粹是排版归一化。 */
export function sameAfterCosmeticRules(a: string, b: string, ctx: RuleContext, rules: RulesFile): boolean {
  const enabled = new Set(rules.toFeishu.filter((entry) => entry.enabled).map((entry) => entry.id));
  const normalize = (text: string): string => {
    let output = text;
    for (const rule of BUILT_IN_RULES.toFeishu) {
      if (!COSMETIC_PUBLISH_RULE_IDS.includes(rule.id) || !enabled.has(rule.id)) continue;
      output = rule.apply(output, ctx);
    }
    return output;
  };
  return normalize(a) === normalize(b);
}

export function ruleEnabled(rules: RulesFile, direction: RuleDirection, id: string): boolean {
  return rules[direction].some((entry) => entry.id === id && entry.enabled);
}
