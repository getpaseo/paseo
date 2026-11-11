import { Parser } from "htmlparser2";
import { fromMarkdown } from "mdast-util-from-markdown";
import { decodeString } from "micromark-util-decode-string";
import type { Nodes } from "mdast";

const ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
const TAG = String.raw`<(?:[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*)>`;
const HTML = new RegExp(
  String.raw`(?<!\\)(?:<!--[\s\S]*?-->|<code\b[^>]*>[\s\S]*?<\/code\s*>|<summary\b[^>]*>[\s\S]*?<\/summary\s*>|${TAG})`,
  "gi",
);
// HTML tag-leading lines carry layout indentation, unlike embedded Markdown text.
const HTML_OR_LINE_INDENT = new RegExp(
  String.raw`${HTML.source}|(?:^|(?<=[\r\n]))[ \t>]+(?=<)`,
  "gi",
);
const FLOW_CONTAINERS = new Set(["root", "blockquote", "listItem"]);
const BLOCK_TAGS = new Set([
  "div",
  "p",
  "table",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
]);
const EMPHASIS: Readonly<Record<string, string>> = { b: "**", strong: "**", i: "*", em: "*" };

/** Convert comment HTML to Markdown while preserving the original spelling of code. */
export function normalizeMarkdownHtml(source: string): string {
  if (!source.includes("<")) return source;
  // `indent` is the container prefix width of an HTML block's lines; inline HTML has none.
  const htmlRanges: { start: number; end: number; indent?: number }[] = [];
  function findHtml(node: Nodes, block: boolean) {
    if (node.type === "html" && node.position) {
      htmlRanges.push({
        start: node.position.start.offset!,
        end: node.position.end.offset!,
        // Whitespace inside <pre> is content.
        indent:
          block && !/^\s*<pre\b/i.test(node.value) ? node.position.start.column - 1 : undefined,
      });
    } else if ("children" in node)
      node.children.forEach((child) => findHtml(child, FLOW_CONTAINERS.has(node.type)));
  }
  findHtml(fromMarkdown(source), false);
  const codeRanges: { start: number; end: number }[] = [];
  // Disable HTML parsing so code inside <details> remains visible to the Markdown parser.
  const tree = fromMarkdown(source, {
    extensions: [{ disable: { null: ["htmlFlow", "htmlText"] } }],
  });
  function protectCode(node: Nodes) {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) codeRanges.push({ start, end });
    } else if ("children" in node) node.children.forEach(protectCode);
  }
  protectCode(tree);
  const links: (string | undefined)[] = [];
  let previousTag: { name: string; end: number } | null = null;
  let preDepth = 0;
  const convert = (raw: string, offset: number, indent: number): string => {
    if (codeRanges.some(({ start, end }) => offset >= start && offset < end)) return raw;
    // Removing tags must not leave layout spaces that start Markdown code.
    // Preserve the quote/list prefix and all indentation on Markdown text lines.
    if (!raw.startsWith("<"))
      return preDepth > 0 ? raw : raw.slice(0, indent) + raw.slice(indent).replace(/^[ \t]+/, "");
    if (raw.startsWith("<!--")) return "";
    const summary = /^<summary\b[^>]*>([\s\S]*?)<\/summary\s*>$/i.exec(raw);
    if (summary) {
      const title = normalizeMarkdownHtml(summary[1]).trim();
      // A summary is one bold paragraph, even when its HTML title uses headings
      // or several block wrappers. Slice AST blocks so inline code stays literal.
      const inline = fromMarkdown(title)
        .children.map(({ position }) => title.slice(position!.start.offset!, position!.end.offset!))
        .join(" ");
      return `**${inline}**\n\n`;
    }
    const code = /^<code\b[^>]*>([\s\S]*?)<\/code\s*>$/i.exec(raw);
    if (code)
      return inlineCode(
        code[1].replace(/&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g, (entity) =>
          decodeString(entity),
        ),
      );
    const closing = raw.startsWith("</");
    const name = /^<\/?([\w-]+)/.exec(raw)?.[1].toLowerCase() ?? "";
    if (name === "pre") preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
    // Each gap is inspected once, rather than searching the complete prefix
    // for a preceding tag on every table row or nested block.
    const startsAfterBoundary = previousTag
      ? BLOCK_TAGS.has(previousTag.name) && /^\s*$/.test(source.slice(previousTag.end, offset))
      : /^\s*$/.test(source.slice(0, offset));
    previousTag = { name, end: offset + raw.length };
    if (EMPHASIS[name]) return EMPHASIS[name];
    const boundary = layoutBoundary(name, source, raw, offset, closing, startsAfterBoundary);
    if (boundary !== null) return boundary;
    if (name === "a") return markdownAnchor(raw, closing, links);
    if (name === "img" && !closing) {
      const { src, alt = "" } = attributes(raw);
      return src ? `![${alt.replace(/[[\]\\]/g, "\\$&")}](<${markdownUrl(src)}>)` : alt;
    }
    return "";
  };
  let result = "";
  let cursor = 0;
  for (const range of htmlRanges) {
    if (range.start < cursor) continue;
    result += source.slice(cursor, range.start);
    // Inline HTML code has separate opening/closing AST nodes. Convert the pair
    // together so its contents keep backslashes and get a safe backtick delimiter.
    const paired = /^<(code|summary)\b[^>]*>[\s\S]*?<\/\1\s*>/i.exec(source.slice(range.start));
    const end = paired ? Math.max(range.end, range.start + paired[0].length) : range.end;
    result += source
      .slice(range.start, end)
      .replace(range.indent === undefined ? HTML : HTML_OR_LINE_INDENT, (raw, offset) =>
        convert(raw, range.start + offset, range.indent ?? 0),
      );
    cursor = end;
  }
  return result + source.slice(cursor);
}

function attributes(tag: string): Record<string, string> {
  let result: Record<string, string> = {};
  const parser = new Parser({
    onopentag: (_name, value) => {
      result = value;
    },
  });
  parser.end(tag);
  return result;
}

function markdownUrl(url: string): string {
  return url.replace(/[<>\r\n]/g, (character) => encodeURIComponent(character));
}

function inlineCode(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const marker = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${marker}${padding}${content}${padding}${marker}`;
}

function markdownAnchor(raw: string, closing: boolean, links: (string | undefined)[]): string {
  if (closing) {
    const href = links.pop();
    return href === undefined ? "" : `](<${markdownUrl(href)}>)`;
  }
  const { href } = attributes(raw);
  links.push(href);
  return href === undefined ? "" : "[";
}

function blockBoundary(
  source: string,
  raw: string,
  offset: number,
  closing: boolean,
  startsAfterBoundary: boolean,
): string {
  if (closing) {
    const following = source.slice(offset + raw.length);
    if (/^\s*$/.test(following) || following.startsWith("\n\n")) return "";
    const nextClosingTag = /^\s*<\/([\w-]+)/.exec(following);
    if (nextClosingTag && BLOCK_TAGS.has(nextClosingTag[1].toLowerCase())) return "";
  } else if (startsAfterBoundary) {
    return "";
  }
  return "\n\n";
}

function layoutBoundary(
  name: string,
  source: string,
  raw: string,
  offset: number,
  closing: boolean,
  startsAfterBoundary: boolean,
): string | null {
  if (name === "br") return closing ? "" : "  \n";
  if (name === "summary") return closing ? "**\n\n" : "**";
  if (name === "details")
    return (closing ? offset + raw.length === source.length : offset === 0) ? "" : "\n\n";
  if (BLOCK_TAGS.has(name)) return blockBoundary(source, raw, offset, closing, startsAfterBoundary);
  if ((name === "td" || name === "th") && closing)
    return /^<t[dh]\b/i.test(source.slice(offset + raw.length)) ? " " : "";
  return null;
}
