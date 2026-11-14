import type { MermaidNodeShape } from "@getpaseo/plugin/client/ui";

const SHAPES = new Set([
  "rounded",
  "stadium",
  "subroutine",
  "cylinder",
  "circle",
  "diamond",
  "hexagon",
]);

type DefaultShape = Exclude<MermaidNodeShape, "rect">;
const ID_EXCLUDED = /[\s[\](){}|;"'`\\<>]/;

function isIdChar(char: string): boolean {
  return char.length === 1 && !ID_EXCLUDED.test(char);
}

function isKeyword(source: string, index: number, word: string): boolean {
  if (!source.startsWith(word, index)) return false;
  const before = index > 0 ? source[index - 1]! : "";
  const after = source[index + word.length] ?? "";
  return !isIdChar(before) && !isIdChar(after);
}

/**
 * Index after a leading frontmatter block. `null` means the block is still
 * open, which happens while a fenced document is streaming.
 */
function preambleEnd(source: string): number | null {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!source.startsWith("---", index)) return index;
  const close = source.indexOf("\n---", index + 3);
  if (close === -1) return null;
  const newline = source.indexOf("\n", close + 4);
  return newline === -1 ? source.length : newline + 1;
}

function isFlowchart(source: string, start: number): boolean {
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (source.startsWith("%%", index)) {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    break;
  }
  return /^(?:flowchart-v2|flowchart|graph)\b/.test(source.slice(index));
}

/** Mermaid only treats double quotes as label delimiters; apostrophes are plain text. */
function isQuoted(label: string): boolean {
  return label.length >= 2 && label[0] === '"' && label[label.length - 1] === '"';
}

function quoteLabel(label: string, delimiters: string): string {
  if (isQuoted(label) || ![...delimiters].some((delimiter) => label.includes(delimiter))) {
    return label;
  }
  return `"${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wrapShape(shape: DefaultShape, label: string): string {
  switch (shape) {
    case "rounded":
      return `(${quoteLabel(label, ")")})`;
    case "stadium":
      return `([${quoteLabel(label, ")]")}])`;
    case "subroutine":
      return `[[${quoteLabel(label, "]")}]]`;
    case "cylinder":
      return `[(${quoteLabel(label, ")]")})]`;
    case "circle":
      return `((${quoteLabel(label, ")")}))`;
    case "diamond":
      return `{${quoteLabel(label, "}")}}`;
    case "hexagon":
      return `{{${quoteLabel(label, "}")}}}`;
  }
}

function readBracketLabel(source: string, open: number): { text: string; end: number } | null {
  let index = open + 1;
  let depth = 1;
  let quote: string | null = null;
  while (index < source.length) {
    const char = source[index]!;
    if (quote) {
      // Mermaid treats a backslash inside a quoted label as ordinary text, so the next quote
      // closes the string.
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open + 1, index), end: index };
    }
    index += 1;
  }
  return null;
}

function isSlantedBracketLabel(text: string): boolean {
  if (text.length < 2) return false;
  const first = text[0];
  const last = text[text.length - 1];
  return (first === "/" || first === "\\") && (last === "/" || last === "\\");
}

function isPlainRectangle(source: string, index: number): boolean {
  if (source[index] !== "[") return false;
  const before = index > 0 ? source[index - 1]! : "";
  if (!isIdChar(before)) return false;
  const next = source[index + 1];
  return next !== "[" && next !== "(";
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline + 1;
}

/** Index of the `;` or newline that ends the statement starting at `index`. */
function statementEnd(source: string, index: number): number {
  let quote = false;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (quote) {
      // Mermaid treats a backslash inside a quoted title as ordinary text, so the next quote
      // closes the title.
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === ";" || char === "\n") return cursor;
  }
  return source.length;
}

interface EdgePattern {
  start: RegExp;
  end: RegExp;
}

const EDGE_PATTERNS: EdgePattern[] = [
  // Solid links: start with <--+, [ox]--+, or --+ (not followed immediately by >)
  {
    start: /^(?:<--+|[ox]--+|--+)(?!>)/,
    end: /^(?:--+>|--+[ox]|--+)/,
  },
  // Thick links: start with <==+, [ox]==+, or ==+ (not followed immediately by >)
  {
    start: /^(?:<==+|[ox]==+|==+)(?!>)/,
    end: /^(?:==+>|==+[ox]|==+)/,
  },
  // Dotted links: start with <-+\.|[ox]-+\.|-\.+(?!>)/
  {
    start: /^(?:<-+\.|[ox]-+\.|-\.+)(?!>)/,
    end: /^(?:\.+->|\.+-[ox]|\.+-)/,
  },
];

/**
 * Returns the end index of an inline edge with label (e.g. `-- label -->` or
 * `-. label .->`) if one starts at `index`, otherwise `null`.
 */
function readInlineEdge(source: string, index: number): number | null {
  for (const pattern of EDGE_PATTERNS) {
    const match = pattern.start.exec(source.slice(index));
    if (!match) continue;
    const startLen = match[0].length;
    let cursor = index + startLen;
    let quote = false;
    while (cursor < source.length) {
      const char = source[cursor];
      if (quote) {
        if (char === '"') quote = false;
        cursor += 1;
        continue;
      }
      if (char === '"') {
        quote = true;
        cursor += 1;
        continue;
      }
      if (char === "\n" || char === ";") break;
      const endMatch = pattern.end.exec(source.slice(cursor));
      if (endMatch) {
        const label = source.slice(index + startLen, cursor);
        if (label.trim().length > 0) {
          return cursor + endMatch[0].length;
        }
      }
      cursor += 1;
    }
  }
  return null;
}

/**
 * Rewrites plain `id[label]` flowchart rectangles. Existing shapes, subgraph
 * titles, comments, edge labels, and `|edge labels|` stay as authored. An unclosed bracket
 * is left alone so a streaming prefix still parses. This never emits `@{`.
 */
function rewriteFlowchart(source: string, shape: DefaultShape): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;
  let inEdgeLabel = false;

  while (index < source.length) {
    const char = source[index]!;
    if (quote) {
      out += char;
      // Mermaid treats a backslash inside a quoted string as ordinary text, so the next quote
      // closes the string.
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "\n") {
      inEdgeLabel = false;
      out += char;
      index += 1;
      continue;
    }
    if (inEdgeLabel) {
      if (char === "|") inEdgeLabel = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (source.startsWith("%%", index)) {
      const end = lineEnd(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (isKeyword(source, index, "subgraph")) {
      // Only the header, so children after a `;` on the same line keep their
      // rewritten shape.
      const end = statementEnd(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === "|") {
      inEdgeLabel = true;
      out += char;
      index += 1;
      continue;
    }
    const edgeEnd = readInlineEdge(source, index);
    if (edgeEnd !== null) {
      out += source.slice(index, edgeEnd);
      index = edgeEnd;
      continue;
    }
    if (isPlainRectangle(source, index)) {
      const label = readBracketLabel(source, index);
      if (!label) {
        out += char;
        index += 1;
        continue;
      }
      if (isSlantedBracketLabel(label.text)) {
        out += source.slice(index, label.end + 1);
        index = label.end + 1;
        continue;
      }
      out += wrapShape(shape, label.text);
      index = label.end + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function applyDefaultNodeShape(source: string, shape: string | undefined): string {
  if (!shape || shape === "rect" || !SHAPES.has(shape)) return source;
  const start = preambleEnd(source);
  if (start === null || !isFlowchart(source, start)) return source;
  return `${source.slice(0, start)}${rewriteFlowchart(source.slice(start), shape as DefaultShape)}`;
}
