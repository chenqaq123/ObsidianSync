import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "feishu-rules-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const outfile = path.join(temp, "rules.cjs");
await esbuild.build({
  entryPoints: [path.join(root, "src/convert/rules.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  alias: { obsidian: path.join(root, "tests/obsidian-stub.ts") },
  outfile,
});
const { applyRules, defaultRulesFile, sourceFormatWarnings, publishRulesFingerprint, sameAfterCosmeticRules } = createRequire(import.meta.url)(outfile);
const ctx = { relPath: "note.md", documentTitle: "note", localContent: "" };
const convert = (text, rules = defaultRulesFile()) => applyRules("toFeishu", text, ctx, rules);
const pull = (text, rules = defaultRulesFile()) => applyRules("toObsidian", text, ctx, rules);
await esbuild.build({
  entryPoints: { syntax: path.join(root, "src/convert/markdown.ts"), docs: path.join(root, "src/feishu/docs.ts") },
  bundle: true, platform: "node", format: "cjs", outdir: temp, outExtension: { ".js": ".cjs" },
  alias: { obsidian: path.join(root, "tests/obsidian-stub.ts") },
});
const { encodeFeishuMath, mathSpans } = createRequire(import.meta.url)(path.join(temp, "syntax.cjs"));
const { buildMarkdownContent } = createRequire(import.meta.url)(path.join(temp, "docs.cjs"));

test("downstream inline math trims boundaries only, including Unicode whitespace", () => {
  assert.equal(pull('当 $ x + y $，以及 $\\text{Agent Memory} $。'), '当 $x + y$，以及 $\\text{Agent Memory}$。');
  assert.equal(pull('当 $\t x \t$、$\u00a0y\u3000$。'), '当 $x$、$y$。');
  assert.equal(pull('当 $ x\\  $ 时'), '当 $x\\space{}$ 时');
  assert.equal(pull('$ $ and $\t$'), '$ $ and $\t$');
});

test("downstream display math keeps spaces and line breaks byte for byte", () => {
  const block = '$$  \r\n\\begin{aligned}\r\n a &= b \\\\\r\n c &= d\r\n\\end{aligned}  \r\n$$';
  assert.equal(pull(block), block);
  assert.equal(pull('$$ x + y $$'), '$$ x + y $$');
  assert.equal(pull('$$\n$ x $\n$$'), '$$\n$ x $\n$$');
  assert.equal(pull('$$URL = path#fragment$$'), '$$URL = path\\#fragment$$');
});

test("prices, escapes, links, frontmatter and code are not mistaken for equations", () => {
  const unchanged = [
    '价格 $5 和 $10；费用 $2.50 / $3.00。',
    '转义 \\$ x \\$；代码 `$ x $`；空 $$$$。',
    '[link](https://example.test/$ x $) ![[cost $ x $.png]]',
    '---\nexample: $ x $\n---',
    '> ```latex\n> $ x $\n> ```',
    '``code\n$ x $\ncode``',
    '    $ x $',
  ];
  for (const input of unchanged) assert.equal(pull(input), input);
  assert.equal(pull('价格 $5 和 $10；公式 $ x + y $'), '价格 $5 和 $10；公式 $x + y$');
});

test("native formula tags and XML titles become Obsidian Markdown without corrupting entities", () => {
  assert.equal(pull('句子 <latex> x &lt; y </latex>。'), '句子 $x < y$。');
  assert.equal(pull('<p align="center"><latex> x &amp; y\n </latex></p>'), '$$\n x & y\n \n$$');
  assert.equal(pull('<latex>\\text{&amp;lt;}</latex>'), '$\\text{&lt;}$');
  const code = '```xml\n<latex> x </latex>\n```\n`<latex> y </latex>`';
  assert.equal(pull(code), code);
  assert.equal(pull('<title>note</title>\n\n内容 $ x $'), '内容 $x$');
  assert.equal(pull('<title>different</title>\n内容'), '<title>different</title>\n内容');
});

test("transport compensates only empirically observed Feishu escapes", () => {
  const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/feishu-math-escapes.json'), 'utf8'));
  for (const sample of fixture.cases) {
    const logical = `<latex>${sample.input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</latex>`;
    const raw = `<latex>${sample.input}</latex>`;
    const expected = sample.input === sample.output ? raw : raw.replace('\\', '\\\\');
    assert.equal(encodeFeishuMath(logical), expected, sample.input);
  }
  const matrix = String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`;
  assert.equal(encodeFeishuMath(`$$${matrix}$$`), `$$${matrix}$$`);
  assert.equal(buildMarkdownContent('note', '<latex>x\\#y</latex>'), '<title>note</title>\n<latex>x\\\\#y</latex>');
  assert.equal(encodeFeishuMath('```\n<latex>x\\#y</latex>\n```'), '```\n<latex>x\\#y</latex>\n```');
  assert.equal(encodeFeishuMath('<latex>x &lt; y &amp; z</latex>'), '<latex>x < y & z</latex>');
  assert.equal(encodeFeishuMath('<p align="center"><latex>x &lt; y &amp; z</latex></p>'), '<p align="center"><latex>x &lt; y &amp; z</latex></p>');
});

test("repeated Feishu-style roundtrips stay stable and keep inline spaces valid", () => {
  const source = '正文 $x + \\text{Agent Memory}$，以及 $\\text{cost: \\$5}$。\n\n$$ a = b \\# c $$';
  const fetched = (text) => encodeFeishuMath(convert(text))
    .replace(/<p align="center"><latex>([\s\S]*?)<\/latex><\/p>/g, (_raw, body) => `$$${body}$$`)
    .replace(/<latex>([\s\S]*?)<\/latex>/g, (_raw, body) => `$ ${body} $`)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\\([#$*_~\[\]&:<>+=`-])/g, '$1');
  const first = pull(fetched(source));
  const second = pull(fetched(first));
  assert.equal(second, first);
  for (const span of mathSpans(second)) if (!span.block) assert.equal(span.body, span.body.trim());
  assert.ok(second.includes('Agent Memory'));
  assert.ok(second.includes(String.raw`\$5`));
});

test("PDF invalid URL formulas: escape only unescaped hashes and use centered native math", () => {
  assert.equal(convert("$$ URL = path#fragment $$"), '<p align="center"><latex>URL = path\\#fragment</latex></p>');
  assert.equal(convert("$$ URL = \\text{legitimate target} # \\text{malicious instruction} $$"), '<p align="center"><latex>URL = \\text{legitimate target} \\# \\text{malicious instruction}</latex></p>');
  assert.equal(convert("句子 $x\\#y$ 结束"), "句子 <latex>x\\#y</latex> 结束");
  assert.equal(convert("句子 $😀\\#x#y$ 结束"), "句子 <latex>😀\\#x\\#y</latex> 结束");
  assert.equal(convert("$$a\\\\#b$$"), '<p align="center"><latex>a\\\\\\#b</latex></p>');
});

test("inline formula and prose keep punctuation and text; XML characters are escaped", () => {
  assert.equal(convert("$g_u$拉向："), "<latex>g_u</latex>拉向：");
  assert.equal(convert("$g_a.$作者继续解释。"), "<latex>g_a.</latex>作者继续解释。");
  assert.equal(convert("当 $x<y & y>z$ 时"), "当 <latex>x&lt;y &amp; y&gt;z</latex> 时");
});

test("block promotion never rewrites nested dollar signs or dollar-only inline code", () => {
  const code = '`$a#b$` and ``x `$ y``';
  assert.equal(convert(code), code);
  const formula = "$$\n\\text{price: \\$5}\n$$";
  assert.equal(convert(formula), '<p align="center"><latex>\\text{price: \\$5}</latex></p>');
  assert.equal(convert("$$unclosed\n```\n$$x#y$$\n```"), "$$unclosed\n```\n$$x#y$$\n```");
});

test("list hard-break exit separates prose without changing nested or deliberate continuations", () => {
  assert.equal(convert("- screenshot；\n- tree。  \n正式主实验使用："), "- screenshot；\n- tree。  \n\n正式主实验使用：");
  assert.equal(convert("- item  \n  continuation"), "- item  \n  continuation");
  assert.equal(convert("- item  \n  - child"), "- item  \n  - child");
  assert.equal(convert("- lazy\ncontinuation"), "- lazy\ncontinuation");
});

test("source damage is diagnosed with line numbers and literal escapes are never guessed away", () => {
  const damaged = '### Topic\n\\$\\$\ny\\_{\\text{benign}}\n# \\text{点击帖子}\n\\$\\$所以这不是：';
  const warnings = sourceFormatWarnings(damaged);
  assert.ok(warnings.some(w => w.includes("第 2 行") && w.includes("转义")));
  assert.ok(warnings.some(w => w.includes("第 3 行") && w.includes("LaTeX")));
  assert.ok(warnings.some(w => w.includes("第 4 行") && w.includes("H1")));
  assert.equal(convert(damaged), damaged);
  assert.deepEqual(sourceFormatWarnings('```\n\\$\\$\n\\text{example}\n```'), []);
  assert.ok(sourceFormatWarnings("$$x").some(w => w.includes("不完整")));
});

test("new rules are idempotent, preserve semantic differences and have stable fingerprints", () => {
  const original = '讲解 $$a=b$$ 收尾\n\n$\\boxed{\\text{Agent}}$和\n$x$';
  const converted = convert(original);
  assert.equal(convert(converted), converted);
  assert.equal(sameAfterCosmeticRules(original, converted, ctx, defaultRulesFile()), true);
  assert.equal(sameAfterCosmeticRules(original, converted + "远端新增", ctx, defaultRulesFile()), false);
  const rules = defaultRulesFile();
  const fingerprint = publishRulesFingerprint(rules);
  rules.toFeishu.reverse();
  rules.toFeishu[0].description = "only a label";
  assert.equal(publishRulesFingerprint(rules), fingerprint);
  rules.toFeishu.find(r => r.id === "native-math").enabled = false;
  assert.notEqual(publishRulesFingerprint(rules), fingerprint);
  assert.equal(convert("$$x$$", rules), "$$x$$");
});

const cases = [
  ["empty line after opening fence", "```js\n\nconst x = 1;\n```"],
  ["empty line between code lines", "```\n$a#b$\n\n$ c#d $\n```"],
  ["consecutive empty lines", "~~~\n\n\n$a#b$\n\n~~~\n"],
  ["unclosed fence ending in empty lines", "```\n$a#b$\n\n"],
  ["CRLF code block", "```\r\n\r\n$ a#b $\r\n```\r\n"],
  ["longer fence containing shorter fence", "````\n```\n\n$a#b$\n````"],
  ["empty line after closing fence", "```\ncode\n```\n\n"],
];

for (const [label, input] of cases) {
  test(label, () => {
    // A timer in the same process cannot interrupt a synchronous infinite loop.
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const { applyRules, defaultRulesFile, sameAfterCosmeticRules } = require(process.argv[1]);
      const input = JSON.parse(process.argv[2]);
      const ctx = { relPath: 'code.md', documentTitle: 'code', localContent: input };
      const rules = defaultRulesFile();
      const convert = text => applyRules('toFeishu', text, ctx, rules);
      assert.equal(convert(input), input, 'code and newlines must be preserved');
      assert.equal(sameAfterCosmeticRules(input, input, ctx, rules), true);
      if (process.argv[3] === 'true') {
        const suffix = '\\n\\n正文 $ x#y $ 结束';
        assert.equal(convert(input + suffix), input + '\\n\\n正文 <latex>x\\\\#y</latex> 结束');
      }
    `, outfile, JSON.stringify(input), String(label !== "unclosed fence ending in empty lines")], { encoding: "utf8", timeout: 2000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}
