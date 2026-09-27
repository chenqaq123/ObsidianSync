import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import { newImageMarker } from "../feishu/docImages";
import type { Logger } from "../log";
import { ensureFolder } from "../log";
import { codeLineMask, decodeXmlText, escapedAt, mapMath, mapNativeMath, mathSpans, trimInlineMathBody } from "./markdown";

/**
 * 文档模式的可编辑转换规则。规则本身是纯函数（字符串进、字符串出），
 * 开关与说明存在 vault 里的 rules.json，与内置默认按 id 合并。
 */

export type RuleDirection = "toFeishu" | "toObsidian";

export const RULES_PATH = ".obsidian/feishu-sync/rules.json";
export const RULES_VERSION = 3;
/** Increment when built-in publishing behavior changes, independently of the editable file version. */
const PUBLISH_RULES_REVISION = 3;

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
  const lines = text.split("\n");
  const code = codeLineMask(lines, false);
  return lines.map((line, index) => code[index] ? line : transform(line)).join("\n");
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

const MATH_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const MATH_TABLE_ROW = /^\s*\|/;
/** 缩进、引用块、标题这类结构行里的公式不拆——硬拆会把公式挪到结构外，反而毁掉原文。 */
const MATH_STRUCTURED_LINE = /^(?:[\t ]|>|#{1,6}\s)/;

/** Shared delimiter scanner keeps inline code, fenced code and unpaired delimiters intact. */
function rewriteMathBodies(input: string, rewrite: (body: string, block: boolean) => string): string {
  return mapMath(input, (span) => {
    const delimiter = span.block ? "$$" : "$";
    return `${delimiter}${rewrite(span.body, span.block)}${delimiter}`;
  });
}

const mathEscapeHash: BuiltInRule = {
  id: "math-escape-hash",
  description:
    "双向：数学环境里的裸 # 写成 \\#，避免公式渲染失败；已转义的 # 不重复转义，代码示例不动，跨行的 $$ 公式同样处理。",
  defaultEnabled: true,
  apply: (input) => rewriteMathBodies(input, (body) => body.replace(/#/g, (_char, index: number) => escapedAt(body, index) ? "#" : "\\#")),
};

const mathTrimInlineSpaces: BuiltInRule = {
  id: "math-trim-inline-spaces",
  description:
    "双向：只清理行内公式定界符内侧的空白（$ x $ → $x$），确保 Obsidian 可识别。保留公式正文、\\text{Agent Memory} 内的空格，以及块级 $$...$$ 的空格和换行；代码、价格与转义美元符号不动。",
  defaultEnabled: true,
  apply: (input) => rewriteMathBodies(input, (body, block) => (block || !body.trim() ? body : trimInlineMathBody(body))),
};

/** 行尾连接词：它跟在公式后面时另起一行，否则飞书会把公式和它排在同一段里。 */
const FORMULA_TAIL_CONNECTOR = /^(?:和|与|及|以及|或者|或|还是|暨|and|or)[\s。，、；：！？.,;:!?]*$/i;
/** 整行起始的一条行内公式，后面可能还有残留内容。 */
const inlineFormulaToBlock: BuiltInRule = {
  id: "inline-formula-to-block",
  description: "上行：普通段落中独占一行的行内公式改成块级公式；尾随连接词另起一段。保留正文、标点和列表/引用/代码结构。",
  defaultEnabled: true,
  apply: (input) => mapMath(input, (span) => {
    if (span.block) return input.slice(span.start, span.end);
    const lineStart = input.lastIndexOf("\n", span.start - 1) + 1;
    const newline = input.indexOf("\n", span.end);
    const lineEnd = newline === -1 ? input.length : newline;
    const prefix = input.slice(lineStart, span.start);
    const tail = input.slice(span.end, lineEnd).trim();
    if (prefix !== "" || (tail && !FORMULA_TAIL_CONNECTOR.test(tail))) return input.slice(span.start, span.end);
    return `$$\n${span.body.trim()}\n$$${tail ? "\n\n" : ""}`;
  }),
};

const blockFormulaOwnParagraph: BuiltInRule = {
  id: "block-formula-own-paragraph",
  description: "上行：普通正文里的块级公式独占段落，前后留空行；列表、表格、引用和缩进结构里的公式保留位置并提示。",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const out: string[] = [];
    let from = 0;
    for (const span of mathSpans(input)) {
      if (!span.block) continue;
      const lineStart = input.lastIndexOf("\n", span.start - 1) + 1;
      const prefix = input.slice(lineStart, span.start);
      if (MATH_STRUCTURED_LINE.test(prefix) || MATH_LIST_ITEM.test(prefix) || MATH_TABLE_ROW.test(prefix)) {
        ctx.warnings?.push(`第 ${input.slice(0, span.start).split("\n").length} 行的块级公式在缩进/列表项/表格/引用/标题里，未拆成独立段落`);
        continue;
      }
      const before = input.slice(from, span.start).replace(/[ \t]+$/, "");
      out.push(before);
      const joined = out.join("");
      if (joined && !joined.endsWith("\n\n")) out.push(joined.endsWith("\n") ? "\n" : "\n\n");
      out.push(input.slice(span.start, span.end));
      from = span.end;
      while (input[from] === " " || input[from] === "\t") from += 1;
      if (from < input.length && !input.slice(from).startsWith("\n\n")) out.push(input[from] === "\n" ? "\n" : "\n\n");
    }
    out.push(input.slice(from));
    return out.join("");
  },
};

/** Markdown accepts Feishu XML extensions. Explicit paragraphs fix left-aligned display math. */
const nativeMath: BuiltInRule = {
  id: "native-math",
  description: "上行：公式使用飞书原生 <latex> 标签；独立块级公式放入居中段落，保留公式与正文的边界。",
  defaultEnabled: true,
  apply: (input) => mapMath(input, (span) => {
    if (!span.body.trim()) return input.slice(span.start, span.end);
    const body = span.body.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const latex = `<latex>${body}</latex>`;
    if (!span.block) return latex;
    const before = input.slice(input.lastIndexOf("\n", span.start - 1) + 1, span.start);
    const end = input.indexOf("\n", span.end);
    const after = input.slice(span.end, end === -1 ? input.length : end);
    return !before.trim() && !after.trim() ? `<p align="center">${latex}</p>` : latex;
  }),
};

const restoreNativeMath: BuiltInRule = {
  id: "restore-native-math",
  description: "下行：把飞书残留的原生公式标签还原为 Obsidian 数学语法；居中公式用 $$...$$，行内公式用 $...$，不把 XML 标签写入笔记。",
  defaultEnabled: true,
  apply: (input) => mapNativeMath(input, (body, block) => {
    const decoded = decodeXmlText(body);
    return block ? `$$\n${decoded}\n$$` : `$${trimInlineMathBody(decoded) || "{}"}$`;
  }),
};

const listExitAfterHardbreak: BuiltInRule = {
  id: "list-exit-after-hardbreak",
  description: "上行：列表项以两个空格硬换行结束，下一行又是无缩进正文时，补空行结束列表；缩进的续行、子列表和代码保持原样。",
  defaultEnabled: true,
  apply: (input) => {
    const lines = input.split("\n");
    const code = codeLineMask(lines);
    return lines.map((line, index) => {
      if (!index || code[index] || code[index - 1]) return line;
      const previous = lines[index - 1];
      const list = /^[ \t]*(?:[-*+]|\d+[.)])\s/.test(previous);
      const hardbreak = / {2,}\r?$/.test(previous);
      const plain = /^[^\s>#|`~]/.test(line) && !/^(?:[-*+]|\d+[.)])\s/.test(line);
      return list && hardbreak && plain ? `\n${line}` : line;
    }).join("\n");
  },
};

/** Diagnostics never guess missing equations or strip literal escapes from source material. */
export function sourceFormatWarnings(input: string): string[] {
  const lines = input.split("\n");
  const code = codeLineMask(lines);
  const masked = mapMath(input, (span) => input.slice(span.start, span.end).replace(/[^\n]/g, " ")).split("\n");
  const warnings: string[] = [];
  let previousHeading = 0;
  for (let row = 0; row < lines.length; row += 1) {
    if (!code[row]) {
      const outside = masked[row];
      const label = `原稿第 ${row + 1} 行`;
      if (/^\\\$\\\$/.test(outside.trim())) warnings.push(`${label}：块级公式定界符已被转义，会显示为字面 $$；请确认原稿，未自动反转义`);
      if (/^(?:#{1,6}\s+)?(?:[A-Za-z]\\?_\{|\\(?:text|rightarrow|left|frac)\b)/.test(outside.trim())) warnings.push(`${label}：LaTeX 疑似落在公式环境外，将显示源码；请修复原稿中的定界符`);
      const heading = /^(#{1,6})\s/.exec(outside);
      if (heading) {
        const level = heading[1].length;
        if ((!previousHeading && level > 1) || level > previousHeading + 1) warnings.push(`${label}：标题层级跳到 H${level}；保留原稿层级，请检查文章结构`);
        if (level === 1 && previousHeading > 1) warnings.push(`${label}：正文中出现 H1 大标题，请确认是否误加了 #`);
        previousHeading = level;
      }
      if (/(^|[^\\])\$\$/.test(outside)) warnings.push(`${label}：公式定界符不完整，已保留原文`);
    }
    if (warnings.length >= 30) { warnings.push("原稿格式提示过多，已省略后续提示"); break; }
  }
  return warnings;
}

const sourceDiagnostics: BuiltInRule = {
  id: "source-format-diagnostics",
  description: "上行：可选的原稿格式检查，默认关闭。开启后提示转义的公式定界符、疑似裸露 LaTeX、标题跳级等问题；只提示，不猜测或改写原意。",
  defaultEnabled: false,
  apply: (input, ctx) => { ctx.warnings?.push(...sourceFormatWarnings(input)); return input; },
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
    const xmlTitle = /^<title>([\s\S]*?)<\/title>(?:\r?\n)?(?:\r?\n)?/.exec(input);
    if (xmlTitle && decodeXmlText(xmlTitle[1]).trim() === title) return input.slice(xmlTitle[0].length);
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
  toFeishu: [
    sourceDiagnostics,
    imageRefNormalize,
    tabIndentToSpaces,
    mathEscapeHash,
    mathTrimInlineSpaces,
    inlineFormulaToBlock,
    blockFormulaOwnParagraph,
    listExitAfterHardbreak,
    nativeMath,
    footnoteDowngrade,
    imageUpload,
  ],
  toObsidian: [unescapeImageMarkup, dropTitleHeading, restoreNativeMath, mathEscapeHash, mathTrimInlineSpaces, imageDownload, restoreImageRef],
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
 * 飞书会固化这些上行排版规则的输出。拉取时用 sameAfterCosmeticRules 识别纯排版差异，
 * 保留本地段落布局；Obsidian 必需的公式边界修复由 normalizeObsidianMath 单独处理。
 */
export const COSMETIC_PUBLISH_RULE_IDS = [
  "math-escape-hash",
  "math-trim-inline-spaces",
  "inline-formula-to-block",
  "block-formula-own-paragraph",
  "list-exit-after-hardbreak",
  "native-math",
];

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

/** Used separately from publishing cosmetics: invalid local math must not be retained by the no-write fast path. */
export function normalizeObsidianMath(input: string, rules: RulesFile): string {
  let out = input;
  for (const rule of [restoreNativeMath, mathEscapeHash, mathTrimInlineSpaces]) {
    if (ruleEnabled(rules, "toObsidian", rule.id)) out = rule.apply(out, { relPath: "", documentTitle: "", localContent: input });
  }
  return out;
}

/** Descriptions and rule-file ordering do not affect actual execution order. */
export function publishRulesFingerprint(rules: RulesFile): string {
  const enabled = new Set(rules.toFeishu.filter((entry) => entry.enabled).map((entry) => entry.id));
  return JSON.stringify([PUBLISH_RULES_REVISION, BUILT_IN_RULES.toFeishu.filter((rule) => rule.id !== "source-format-diagnostics" && enabled.has(rule.id)).map((rule) => rule.id)]);
}

/** Preview must also be invalidated when pull rules change before execution. */
export function pullRulesFingerprint(rules: RulesFile): string {
  const enabled = new Set(rules.toObsidian.filter((entry) => entry.enabled).map((entry) => entry.id));
  return JSON.stringify([1, BUILT_IN_RULES.toObsidian.filter((rule) => enabled.has(rule.id)).map((rule) => rule.id)]);
}
