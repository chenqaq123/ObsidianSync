/** Small, lossless scanner: only paired math delimiters outside code are transformed. */
export interface MathSpan {
  start: number;
  end: number;
  body: string;
  block: boolean;
}

export function escapedAt(text: string, pos: number): boolean {
  let count = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

/** Fence length and character must match; a shorter or different fence is code. */
export function codeLineMask(lines: string[], includeIndentedCode = true): boolean[] {
  let fence: string | undefined;
  let frontmatter = lines[0]?.replace(/\r$/, "") === "---";
  return lines.map((line, index) => {
    if (frontmatter) {
      if (index > 0 && /^(---|\.\.\.)\r?$/.test(line)) frontmatter = false;
      return true;
    }
    const unquoted = line.replace(/^(?:[\t ]*>[\t ]?)+/, "");
    const match = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(unquoted.replace(/\r$/, ""));
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      return true;
    }
    if (match) {
      fence = match[1];
      return true;
    }
    return includeIndentedCode && /^(?: {4}|\t)/.test(unquoted);
  });
}

export function mathSpans(text: string): MathSpan[] {
  const lines = text.split("\n");
  const code = codeLineMask(lines);
  const spans: MathSpan[] = [];
  let offset = 0;
  let blockStart: number | undefined;
  let xmlUntil = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (code[row] && blockStart === undefined) {
      offset += line.length + 1;
      continue;
    }
    // Do not let an unclosed equation consume a subsequent fenced code sample.
    if (blockStart !== undefined && /^[\t ]*(`{3,}|~{3,})/.test(line)) {
      blockStart = undefined;
      offset += line.length + 1;
      continue;
    }
    for (let i = 0; i < line.length;) {
      if (offset + i < xmlUntil) { i = Math.min(line.length, xmlUntil - offset); continue; }
      if (blockStart === undefined && line.startsWith("<latex>", i) && !escapedAt(line, i)) {
        const close = text.indexOf("</latex>", offset + i + 7);
        if (close !== -1) { xmlUntil = close + 8; continue; }
      }
      if (blockStart === undefined && line[i] === "`" && !escapedAt(line, i)) {
        const ticks = /^`+/.exec(line.slice(i))![0];
        let close = text.indexOf(ticks, offset + i + ticks.length);
        while (close !== -1 && (text[close - 1] === "`" || text[close + ticks.length] === "`")) close = text.indexOf(ticks, close + ticks.length);
        if (close !== -1) xmlUntil = close + ticks.length;
        i += ticks.length;
        continue;
      }
      if (blockStart === undefined && line.startsWith("](", i)) {
        let depth = 1;
        let end = i + 2;
        for (; end < line.length && depth > 0; end += 1) {
          if (escapedAt(line, end)) continue;
          if (line[end] === "(") depth += 1;
          if (line[end] === ")") depth -= 1;
        }
        if (depth === 0) { i = end; continue; }
      }
      if (blockStart === undefined && line.startsWith("[[", i)) {
        const end = line.indexOf("]]", i + 2);
        if (end !== -1) { i = end + 2; continue; }
      }
      if (line[i] !== "$" || escapedAt(line, i)) { i += 1; continue; }
      const dollarRun = /^\$+/.exec(line.slice(i))![0].length;
      if (dollarRun > 2) { i += dollarRun; continue; }
      if (line.startsWith("$$", i)) {
        if (blockStart === undefined) blockStart = offset + i;
        else {
          spans.push({ start: blockStart, end: offset + i + 2, body: text.slice(blockStart + 2, offset + i), block: true });
          blockStart = undefined;
        }
        i += 2;
        continue;
      }
      if (blockStart !== undefined) { i += 1; continue; }
      let close = i + 1;
      while (close < line.length && (line[close] !== "$" || escapedAt(line, close))) close += 1;
      const body = line.slice(i + 1, close);
      const amount = /^-?\d[\d,.]*(.*)$/.exec(body);
      // Do not pair a currency amount with the opening delimiter of a later real formula.
      if (amount && /[\p{L};；]/u.test(amount[1]) && !/[\\^_=<>+*/{}()-]/.test(amount[1])) { i += 1; continue; }
      // A closing delimiter immediately before a digit is usually a second price ($5 and $10).
      if (close < line.length && close > i + 1 && line[close + 1] !== "$" && !/\d/.test(line[close + 1] ?? "")) {
        spans.push({ start: offset + i, end: offset + close + 1, body, block: false });
        i = close + 1;
      } else i += 1;
    }
    offset += line.length + 1;
  }
  return spans;
}

/** Remove boundary whitespace only; TeX text, matrix spacing and explicit control spaces are content. */
export function trimInlineMathBody(body: string): string {
  let end = body.length;
  while (end > 0 && /\s/.test(body[end - 1])) {
    if (body[end - 1] === " " && escapedAt(body, end - 1)) {
      return body.slice(0, end - 2).trimStart() + "\\space{}";
    }
    end -= 1;
  }
  return body.slice(0, end).trimStart();
}

export function mapMath(text: string, rewrite: (span: MathSpan) => string): string {
  const out: string[] = [];
  let from = 0;
  for (const span of mathSpans(text)) {
    out.push(text.slice(from, span.start), rewrite(span));
    from = span.end;
  }
  out.push(text.slice(from));
  return out.join("");
}

/** Only known native formula tags are decoded; literal tags in code remain examples. */
export function mapNativeMath(text: string, rewrite: (body: string, block: boolean) => string): string {
  const lines = text.split("\n");
  const code = codeLineMask(lines);
  const protectedRanges: { start: number; end: number }[] = [];
  let offset = 0;
  for (let row = 0; row < lines.length; row += 1) {
    if (code[row]) protectedRanges.push({ start: offset, end: offset + lines[row].length });
    offset += lines[row].length + 1;
  }
  const ticks = /`+/g;
  let tick: RegExpExecArray | null;
  while ((tick = ticks.exec(text))) {
    if (escapedAt(text, tick.index) || protectedRanges.some(r => tick!.index >= r.start && tick!.index < r.end)) continue;
    let close = text.indexOf(tick[0], ticks.lastIndex);
    while (close !== -1 && (text[close - 1] === "`" || text[close + tick[0].length] === "`")) close = text.indexOf(tick[0], close + tick[0].length);
    if (close !== -1) {
      protectedRanges.push({ start: tick.index, end: close + tick[0].length });
      ticks.lastIndex = close + tick[0].length;
    }
  }
  return text.replace(/<p align="center">\s*<latex>([\s\S]*?)<\/latex>\s*<\/p>|<latex>([\s\S]*?)<\/latex>/g,
    (raw, blockBody: string | undefined, inlineBody: string | undefined, start: number) => {
      if (escapedAt(text, start) || protectedRanges.some(r => start < r.end && start + raw.length > r.start)) return raw;
      return rewrite(blockBody ?? inlineBody ?? "", blockBody !== undefined);
    });
}

/** One layer only: &amp;lt; denotes literal &lt;, not a less-than sign. */
export function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (entity[1] !== "#") return named[entity.toLowerCase()] ?? entity;
    const value = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

/** Verified against docs_ai: only these punctuation escapes lose one backslash on write. */
export function encodeFeishuMath(markdown: string): string {
  const compensate = (body: string) => body.replace(/\\(?=[#$*_~\[\]&:<>+=`-])/g, "\\\\");
  const native = mapNativeMath(markdown, (body, block) => {
    const value = compensate(decodeXmlText(body));
    // docs_ai decodes entities in XML paragraphs, but retains them literally in inline <latex>.
    const escaped = block ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : value;
    const latex = `<latex>${escaped}</latex>`;
    return block ? `<p align="center">${latex}</p>` : latex;
  });
  return mapMath(native, span => {
    const delimiter = span.block ? "$$" : "$";
    return `${delimiter}${compensate(span.body)}${delimiter}`;
  });
}
