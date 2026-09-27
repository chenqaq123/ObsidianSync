import { sha256Hex } from "./sync/hash";

/** 报告固定写进 vault 根目录；测试页与测试文档不自动清理，位置写在报告里。 */
export const ROUNDTRIP_REPORT_PATH = "feishu-sync-roundtrip-report.md";

const MAX_DIFF_LINES = 40;

/**
 * 固定追加到样本笔记后面的语法样本。每条语法都对应下面 SYNTAX_CHECKS 里的一条原文，
 * 用来测量「飞书 docs_ai 转换」这一趟到底保住了什么。
 */
export const SYNTAX_SAMPLE = [
  "<!-- 往返测试语法样本：由「测试：Markdown 往返转换」命令追加，用于测量官方转换的保真度 -->",
  "",
  "---",
  "",
  "roundtrip_probe: true",
  "roundtrip_note: 语法样本",
  "roundtrip_tags:",
  "  - 往返测试",
  "",
  "---",
  "",
  "## 往返测试语法样本",
  "",
  "- [ ] 待办：确认这一行是否原样回来",
  "- [x] 已完成：确认勾选状态",
  "",
  "- 无序列表一级",
  "  - 无序列表二级",
  "    1. 有序列表三级",
  "       - 无序列表四级",
  "",
  "**加粗文本** / *斜体文本* / ~~删除线文本~~ / `行内代码`",
  "",
  "> [!note] 提示",
  "> callout 正文：确认 callout 类型与正文都保留",
  "",
  "行内公式 $E = mc^2$，以及行内公式 $\\alpha + \\beta = \\gamma$。",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| 语法 | 本地原文 | 飞书取回 |",
  "| --- | --- | --- |",
  "| 表格 | 三列两行 | 待核对 |",
  "",
  "```js",
  'const roundtrip = "语法样本";',
  "console.log(roundtrip);",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[本地 Markdown] --> B[飞书 docx]",
  "  B --> C[取回 Markdown]",
  "```",
  "",
  "双链引用：[[往返测试目标笔记]]",
  "",
  "标签：#往返测试/语法样本",
  "",
  "图片引用（Wiki 嵌入）：![[Pasted image 20260921000000.png]]",
  "",
  "图片引用（标准 Markdown）：![示例图片](attachments/roundtrip-sample.png)",
  "",
  "脚注引用[^roundtrip]，确认脚注定义能否保留。",
  "",
  "[^roundtrip]: 脚注正文：确认定义能否保留。",
  "",
  "> 普通引用块：确认与 callout 的区分",
].join("\n");

export interface SyntaxCheck {
  label: string;
  needle: string;
}

export const SYNTAX_CHECKS: SyntaxCheck[] = [
  { label: "待办（未完成）", needle: "- [ ] 待办：确认这一行是否原样回来" },
  { label: "待办（已完成）", needle: "- [x] 已完成：确认勾选状态" },
  { label: "多级列表（第四级）", needle: "- 无序列表四级" },
  { label: "加粗 / 斜体 / 删除线", needle: "**加粗文本** / *斜体文本* / ~~删除线文本~~" },
  { label: "行内公式", needle: "$E = mc^2$" },
  { label: "块级公式", needle: "\\int_0^1 x^2 \\, dx = \\frac{1}{3}" },
  { label: "callout", needle: "> [!note] 提示" },
  { label: "表格", needle: "| 语法 | 本地原文 | 飞书取回 |" },
  { label: "代码块（js）", needle: 'const roundtrip = "语法样本";' },
  { label: "mermaid 代码块", needle: "A[本地 Markdown] --> B[飞书 docx]" },
  { label: "双链", needle: "[[往返测试目标笔记]]" },
  { label: "标签", needle: "#往返测试/语法样本" },
  { label: "frontmatter 块", needle: "roundtrip_probe: true" },
  { label: "图片（Wiki 嵌入）", needle: "![[Pasted image 20260921000000.png]]" },
  { label: "图片（标准 Markdown）", needle: "![示例图片](attachments/roundtrip-sample.png)" },
  { label: "脚注", needle: "[^roundtrip]: 脚注正文：确认定义能否保留。" },
];

export function appendSyntaxSample(markdown: string): string {
  return `${markdown}\n\n${SYNTAX_SAMPLE}`;
}

export function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface SyntaxCheckResult extends SyntaxCheck {
  /** 命中的行号（1 起）；没命中就是 undefined */
  line?: number;
  /** 样本自身缺这条原文时无法判断，不能记成 ❌ */
  sampleMissing: boolean;
}

/** 按行查找原文：命中即认为该语法逐字保留。 */
export function checkSyntaxPresence(content: string, checks: SyntaxCheck[] = SYNTAX_CHECKS): SyntaxCheckResult[] {
  const lines = content.split("\n");
  return checks.map((check) => {
    const index = lines.findIndex((line) => line.includes(check.needle));
    return { ...check, line: index >= 0 ? index + 1 : undefined, sampleMissing: false };
  });
}

function markMissingSamples(sent: string, results: SyntaxCheckResult[]): SyntaxCheckResult[] {
  const sentLines = sent.split("\n");
  return results.map((result) => ({
    ...result,
    sampleMissing: !sentLines.some((line) => line.includes(result.needle)),
  }));
}

export interface LineDiff {
  onlyInFirst: string[];
  onlyInSecond: string[];
  firstLineCount: number;
  secondLineCount: number;
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** 行级多重集 diff：算出只在一侧出现的行（不看顺序，只看"这行还有没有配额"）。 */
export function diffLines(first: string, second: string): LineDiff {
  const firstLines = first.split("\n");
  const secondLines = second.split("\n");

  const budgetForFirst = countLines(secondLines);
  const onlyInFirst: string[] = [];
  for (const line of firstLines) {
    const left = budgetForFirst.get(line) ?? 0;
    if (left > 0) budgetForFirst.set(line, left - 1);
    else onlyInFirst.push(line);
  }

  const budgetForSecond = countLines(firstLines);
  const onlyInSecond: string[] = [];
  for (const line of secondLines) {
    const left = budgetForSecond.get(line) ?? 0;
    if (left > 0) budgetForSecond.set(line, left - 1);
    else onlyInSecond.push(line);
  }

  return { onlyInFirst, onlyInSecond, firstLineCount: firstLines.length, secondLineCount: secondLines.length };
}

function visibleLine(line: string): string {
  if (line === "") return "（空行）";
  if (line.trim() === "") return `（空白行：${line.length} 个空格/制表符）`;
  return line;
}

function renderLineList(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [`**${title}**：无`, ""];
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const out = [`**${title}**：共 ${lines.length} 行${lines.length > shown.length ? `（只列出前 ${MAX_DIFF_LINES} 行）` : ""}`, ""];
  const fence = fenceFor(shown.join("\n"));
  out.push(`${fence}text`, ...shown.map(visibleLine), fence, "");
  return out;
}

function renderDiffBlock(label: string, first: string, second: string): string[] {
  const diff = diffLines(first, second);
  const out = [`### ${label}`, ""];
  if (diff.onlyInFirst.length === 0 && diff.onlyInSecond.length === 0) {
    out.push(`两侧行内容一致（按行多重集比较，忽略顺序）：各 ${diff.firstLineCount} / ${diff.secondLineCount} 行。`, "");
    return out;
  }
  out.push(`- 行数：左侧 ${diff.firstLineCount} 行，右侧 ${diff.secondLineCount} 行`);
  out.push(`- 只有左侧有：${diff.onlyInFirst.length} 行；只有右侧有：${diff.onlyInSecond.length} 行`, "");
  out.push(...renderLineList("只有左侧有的行", diff.onlyInFirst));
  out.push(...renderLineList("只有右侧有的行", diff.onlyInSecond));
  return out;
}

function fenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderCodeBlock(content: string): string[] {
  const fence = fenceFor(content);
  return [`${fence}text`, content, fence];
}

export interface Fingerprint {
  chars: number;
  bytes: number;
  lines: number;
  sha256: string;
}

export async function fingerprint(text: string): Promise<Fingerprint> {
  const encoded = new TextEncoder().encode(text);
  return {
    chars: text.length,
    bytes: encoded.byteLength,
    lines: text.split("\n").length,
    sha256: await sha256Hex(encoded.buffer as ArrayBuffer),
  };
}

export interface RoundtripReportInput {
  notePath: string;
  noteText: string;
  documentTitle: string;
  spaceId: string;
  containerTitle: string;
  containerNodeToken: string;
  documentId: string;
  documentUrl?: string;
  wikiNodeToken?: string;
  localContent: string;
  sentContent: string;
  firstFetch: string;
  secondFetch: string;
  startedAt: Date;
  finishedAt: Date;
  apiLog: string[];
}

export async function renderRoundtripReport(input: RoundtripReportInput): Promise<string> {
  const [note, local, sent, first, second] = await Promise.all([
    fingerprint(input.noteText),
    fingerprint(input.localContent),
    fingerprint(input.sentContent),
    fingerprint(input.firstFetch),
    fingerprint(input.secondFetch),
  ]);
  const firstChecks = markMissingSamples(input.sentContent, checkSyntaxPresence(input.firstFetch));
  const secondChecks = markMissingSamples(input.sentContent, checkSyntaxPresence(input.secondFetch));
  const stable = input.firstFetch === input.secondFetch;

  const lines: string[] = [];
  lines.push("# 飞书 Markdown 往返转换实测报告", "");
  lines.push("本报告由插件命令「测试：Markdown 往返转换」生成：把当前笔记（只读）+ 一段固定语法样本，");
  lines.push("经 `docs_ai` 接口写成飞书新版文档（docx），再取回 Markdown，用来看官方转换的保真度。", "");
  lines.push("## 基本信息", "");
  lines.push(`- 生成时间：${formatTimestamp(input.finishedAt)}（本地时间，耗时 ${Math.round((input.finishedAt.getTime() - input.startedAt.getTime()) / 1000)} 秒）`);
  lines.push(`- 样本笔记：\`${input.notePath}\`（只读，未做任何修改）`);
  lines.push(`- 样本笔记原文：${note.chars} 字符 / ${note.bytes} 字节 UTF-8 / sha256 \`${note.sha256}\`（用来核对笔记没有被改动）`);
  lines.push(`- 文档标题：${input.documentTitle}`);
  lines.push(`- document_id：\`${input.documentId}\``);
  lines.push(`- 文档 URL：${input.documentUrl ? input.documentUrl : "（服务端未返回，用 document_id 在飞书里搜）"}`);
  lines.push(`- 知识空间：\`${input.spaceId}\``);
  lines.push(`- 测试页位置：知识空间顶层页面「${input.containerTitle}」（node_token \`${input.containerNodeToken}\`）下的子页面「${input.documentTitle}」`);
  lines.push(
    input.wikiNodeToken
      ? `- 知识库节点：node_token \`${input.wikiNodeToken}\`（链接形如 https://<你的飞书域名>/wiki/${input.wikiNodeToken}）`
      : "- 知识库节点：移动后没能查到节点 token，请在知识空间里按标题查找",
  );
  lines.push("- 测试页与测试文档不会自动清理，看完可以手动删除。", "");
  lines.push("## 这一趟调用的接口", "");
  for (const entry of input.apiLog) lines.push(`- ${entry}`);
  lines.push("");
  lines.push("## ① 原始本地内容（当前笔记 + 追加的语法样本）");
  lines.push("");
  lines.push(...renderCodeBlock(input.localContent));
  lines.push("");
  lines.push("## ② 实际发给飞书的 content（含 `<title>`）");
  lines.push("");
  lines.push(...renderCodeBlock(input.sentContent));
  lines.push("");
  lines.push("## ③ 第一次取回（创建后立刻 fetch）");
  lines.push("");
  lines.push(...renderCodeBlock(input.firstFetch));
  lines.push("");
  lines.push("## ④ 第二次取回（用同一份 content 再 overwrite 更新一次后 fetch）");
  lines.push("");
  lines.push(...renderCodeBlock(input.secondFetch));
  lines.push("");
  lines.push("## 逐行差异摘要", "");
  lines.push(...renderDiffBlock("② 发给飞书的 content → ③ 第一次取回", input.sentContent, input.firstFetch));
  lines.push(...renderDiffBlock("② 发给飞书的 content → ④ 第二次取回", input.sentContent, input.secondFetch));
  lines.push(...renderDiffBlock("③ 第一次取回 → ④ 第二次取回（更新路径是否稳定）", input.firstFetch, input.secondFetch));
  lines.push("## 内容指纹", "");
  lines.push("| 段落 | 字符数 | UTF-8 字节 | 行数 | sha256 |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(`| ① 原始本地内容 | ${local.chars} | ${local.bytes} | ${local.lines} | \`${local.sha256}\` |`);
  lines.push(`| ② 发给飞书的 content | ${sent.chars} | ${sent.bytes} | ${sent.lines} | \`${sent.sha256}\` |`);
  lines.push(`| ③ 第一次取回 | ${first.chars} | ${first.bytes} | ${first.lines} | \`${first.sha256}\` |`);
  lines.push(`| ④ 第二次取回 | ${second.chars} | ${second.bytes} | ${second.lines} | \`${second.sha256}\` |`);
  lines.push("");
  lines.push(`- ③ 与 ④ ${stable ? "逐字节一致（更新路径稳定）" : "不一致（更新后再取回的内容有变化）"}`);
  lines.push(`- ② 与 ③ ${sent.sha256 === first.sha256 ? "逐字节一致（这一趟没有任何损失）" : "不一致（转换有损失，差异见上）"}`, "");
  lines.push("## 语法样本逐行核对", "");
  lines.push("判定方式：在取回内容里逐行查找样本原文，某一行包含该原文即视为逐字保留（行号是取回内容里的行号）。", "");
  lines.push("| 语法 | 样本原文 | 第一次取回 | 第二次取回 |");
  lines.push("| --- | --- | --- | --- |");
  for (let index = 0; index < firstChecks.length; index += 1) {
    const firstCheck = firstChecks[index];
    const secondCheck = secondChecks[index];
    const cell = (result: SyntaxCheckResult): string =>
      result.sampleMissing ? "⚠ 样本里没有" : result.line ? `✅ 第 ${result.line} 行` : "❌ 未找到";
    lines.push(`| ${firstCheck.label} | \`${firstCheck.needle.replace(/\|/g, "\\|")}\` | ${cell(firstCheck)} | ${cell(secondCheck)} |`);
  }
  lines.push("");
  lines.push("## 说明与局限", "");
  lines.push("- 本命令只读本地笔记，不会写回或删除任何笔记；也不会改动同步状态。");
  lines.push("- 图片没有上传：官方 CLI 会先把本地图片引用换成内部标记、创建文档后再上传并绑定；本命令把图片引用原样发给服务端，所以图片那一行反映的是「裸传 Markdown」的结果。");
  lines.push("- 样本是追加在笔记正文之后的，所以那个 `---` 块不是文件头 frontmatter（Obsidian 只认文件头的），但它同样能测出转换器对 `---` 分隔块的处理。");
  lines.push("- 报告写在 vault 根目录，会被当成普通笔记参与后续同步。");
  lines.push("");
  return lines.join("\n");
}
