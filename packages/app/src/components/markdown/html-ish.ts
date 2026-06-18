import { Parser } from "htmlparser2";

export interface MarkdownTextPart {
  kind: "markdown";
  text: string;
}

export interface MarkdownDetailsPart {
  kind: "details";
  summary: string;
  body: string;
  bodyParts?: MarkdownDisplayPart[];
}

export interface MarkdownInlineImagePart {
  kind: "inlineImage";
  alt: string;
  src: string;
  href?: string;
  width?: number;
  height?: number;
  /** The image starts a line and text continues on that same line. */
  flowsWithText?: boolean;
}

export type MarkdownDisplayPart = MarkdownTextPart | MarkdownDetailsPart | MarkdownInlineImagePart;

const FENCE_LINE_RE = /^ {0,3}([`~]{3,})[^\n\r]*(?:\r?\n|$)/gm;
const BACKTICK_RUN_RE = /`+/g;
const SAFE_IMAGE_SRC_RE = /^(https?:\/\/|data:image\/(?:png|gif|jpe?g);base64,)/i;
const SAFE_LINK_HREF_RE = /^(https?:\/\/|#(?:$|[\w-]))/i;
const VOID_HTML_TAGS = new Set(["br", "img"]);

interface ProtectedMarkdownRange {
  start: number;
  end: number;
}

interface MarkdownImageDimensions {
  width?: number;
  height?: number;
}

interface HtmlTextToken {
  kind: "text";
  value: string;
}

interface HtmlCommentToken {
  kind: "comment";
}

interface HtmlTagToken {
  kind: "tag";
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
  raw: string;
}

type HtmlToken = HtmlTextToken | HtmlCommentToken | HtmlTagToken;

interface InlineImageParseResult {
  part: MarkdownInlineImagePart;
  end: number;
}

interface MarkdownDelimiterMatch {
  index: number;
  end: number;
}

interface HtmlishTokenParser {
  write(chunk: string): void;
  skip(length: number): void;
  end(): void;
}

export function splitHtmlishMarkdown(source: string): MarkdownDisplayPart[] {
  return splitHtmlishTokens(tokenizeHtmlishMarkdown(source));
}

function splitHtmlishTokens(tokens: HtmlToken[]): MarkdownDisplayPart[] {
  const parts: MarkdownDisplayPart[] = [];
  let cursor = 0;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (isOpenTag(token, "details")) {
      const closeIndex = findMatchingClose(tokens, cursor, "details");
      if (closeIndex !== null) {
        const details = parseDetailsTokens(tokens.slice(cursor + 1, closeIndex));
        if (details) {
          parts.push(details);
          cursor = closeIndex + 1;
          continue;
        }
      }
    }

    const inlineImage = parseInlineImageAt(tokens, cursor);
    if (inlineImage) {
      parts.push(
        flowsWithFollowingText(tokens, cursor, inlineImage.end)
          ? { ...inlineImage.part, flowsWithText: true }
          : inlineImage.part,
      );
      cursor = inlineImage.end;
      continue;
    }

    const nextDetailsIndex = findNextOpenTag(tokens, cursor + 1, "details");
    const nextInlineImageIndex = findNextInlineImageIndex(tokens, cursor + 1);
    const end = Math.min(nextDetailsIndex ?? tokens.length, nextInlineImageIndex ?? tokens.length);
    appendMarkdownPart(parts, renderInlineTokens(tokens.slice(cursor, end)));
    cursor = end;
  }

  return parts;
}

function parseInlineImageAt(tokens: HtmlToken[], start: number): InlineImageParseResult | null {
  const token = tokens[start];
  if (token?.kind !== "tag" || token.closing) {
    return null;
  }

  if (token.name === "img") {
    const image = imageTokenToInlineImage(token, undefined);
    return image ? { part: image, end: start + 1 } : null;
  }

  if (token.name !== "a") {
    return null;
  }

  const closeIndex = findMatchingClose(tokens, start, "a");
  if (closeIndex === null) {
    return null;
  }

  const image = getSingleImageChild(tokens.slice(start + 1, closeIndex));
  if (!image) {
    return null;
  }

  const inlineImage = imageTokenToInlineImage(image, safeHref(token.attributes.href));
  return inlineImage ? { part: inlineImage, end: closeIndex + 1 } : null;
}

function flowsWithFollowingText(tokens: HtmlToken[], start: number, end: number): boolean {
  const previous = tokens[start - 1];
  // At line start if nothing precedes this image, or the preceding token ends with only
  // whitespace since the last newline (covers a bare space between two images on the same line).
  const atLineStart =
    previous === undefined ||
    (previous.kind === "text" && /(?:^|[\n\r])[ \t]*$/.test(previous.value));
  if (!atLineStart) {
    return false;
  }

  // Scan forward past same-line whitespace-only text tokens and inline images to find
  // the first substantive text token, without crossing a newline.
  let cursor = end;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === undefined) {
      break;
    }
    if (token.kind === "text") {
      const sameLine = token.value.split(/\r?\n/, 1)[0] ?? "";
      if (sameLine.trim().length > 0) {
        return true;
      }
      // Whitespace-only on this line — keep scanning only if no newline was crossed.
      if (token.value.includes("\n") || token.value.includes("\r")) {
        return false;
      }
      cursor += 1;
      continue;
    }
    // An inline image tag — skip over it (the image itself and its possible wrapping close tag).
    if (token.kind === "tag") {
      const imageResult = parseInlineImageAt(tokens, cursor);
      if (imageResult) {
        cursor = imageResult.end;
        continue;
      }
    }
    break;
  }
  return false;
}

function findNextInlineImageIndex(tokens: HtmlToken[], start: number): number | null {
  for (let index = start; index < tokens.length; index += 1) {
    if (parseInlineImageAt(tokens, index)) {
      return index;
    }
  }
  return null;
}

function appendMarkdownPart(parts: MarkdownDisplayPart[], text: string): void {
  if (!text) {
    return;
  }
  const previous = parts.at(-1);
  if (previous?.kind === "markdown") {
    previous.text += text;
    return;
  }
  parts.push({ kind: "markdown", text });
}

function parseDetailsTokens(tokens: HtmlToken[]): MarkdownDetailsPart | null {
  const summaryOpenIndex = findNextOpenTag(tokens, 0, "summary");
  if (summaryOpenIndex === null) {
    return null;
  }

  const summaryCloseIndex = findMatchingClose(tokens, summaryOpenIndex, "summary");
  if (summaryCloseIndex === null) {
    return null;
  }

  const summaryTokens = tokens.slice(summaryOpenIndex + 1, summaryCloseIndex);
  const bodyTokens = [...tokens.slice(0, summaryOpenIndex), ...tokens.slice(summaryCloseIndex + 1)];
  const summary = renderSummaryTokens(summaryTokens).trim();
  if (!summary) {
    return null;
  }

  const bodyParts = splitHtmlishTokens(bodyTokens);
  const body = renderBodyText(bodyParts);

  return {
    kind: "details",
    summary,
    body: body.trim(),
    ...(bodyParts.some((part) => part.kind !== "markdown")
      ? { bodyParts: trimBodyParts(bodyParts) }
      : {}),
  };
}

function renderBodyText(parts: MarkdownDisplayPart[]): string {
  return parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("");
}

function trimBodyParts(parts: MarkdownDisplayPart[]): MarkdownDisplayPart[] {
  const trimmed = [...parts];
  const first = trimmed[0];
  if (first?.kind === "markdown") {
    first.text = first.text.trimStart();
  }
  const last = trimmed.at(-1);
  if (last?.kind === "markdown") {
    last.text = last.text.trimEnd();
  }
  return trimmed.filter((part) => part.kind !== "markdown" || part.text.length > 0);
}

function renderSummaryTokens(tokens: HtmlToken[]): string {
  return stripSingleHeadingWrapper(renderInlineTokens(tokens));
}

function stripSingleHeadingWrapper(text: string): string {
  const tokens = tokenizeHtmlishMarkdown(text.trim());
  if (tokens.length < 3) {
    return text;
  }

  const first = tokens[0];
  const last = tokens.at(-1);
  if (!isHeadingTag(first) || !isClosingTag(last, first.name)) {
    return text;
  }

  return renderInlineTokens(tokens.slice(1, -1));
}

function renderInlineTokens(tokens: HtmlToken[]): string {
  let output = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.kind === "text") {
      output += token.value;
      continue;
    }
    if (token.kind === "comment" || token.closing) {
      continue;
    }

    if (token.name === "br") {
      output += "\n";
      continue;
    }

    if (token.name === "img") {
      output += renderImageToken(token);
      continue;
    }

    const closeIndex = token.selfClosing ? null : findMatchingClose(tokens, index, token.name);
    if (closeIndex === null) {
      output += renderUnknownTag(token);
      continue;
    }

    const children = tokens.slice(index + 1, closeIndex);
    if (token.name === "a") {
      output += renderLinkToken(token, children);
      index = closeIndex;
      continue;
    }
    if (token.name === "sub") {
      output += renderInlineTokens(children);
      index = closeIndex;
      continue;
    }
    if (token.name === "code" && children.every((child) => child.kind === "text")) {
      output += `\`${renderInlineTokens(children)}\``;
      index = closeIndex;
      continue;
    }
    const rawTag = token.raw;
    const tagName = token.name;
    if (isHeadingTag(token)) {
      output += renderInlineTokens(children);
      index = closeIndex;
      continue;
    }

    output += `${rawTag}${renderInlineTokens(children)}</${tagName}>`;
    index = closeIndex;
  }

  return output;
}

function renderImageToken(token: HtmlTagToken): string {
  const image = imageTokenToInlineImage(token, undefined);
  if (!image) {
    return token.raw;
  }

  return `![${escapeMarkdownImageAlt(image.alt)}](${image.src})`;
}

function renderLinkToken(token: HtmlTagToken, children: HtmlToken[]): string {
  const imageOnly = getSingleImageChild(children);
  if (imageOnly) {
    return renderImageToken(imageOnly);
  }

  const label = renderInlineTokens(children);
  const href = token.attributes.href ?? "";
  if (!label || !SAFE_LINK_HREF_RE.test(href) || href === "#") {
    return label;
  }

  return `[${label}](${href})`;
}

function imageTokenToInlineImage(
  token: HtmlTagToken,
  href: string | undefined,
): MarkdownInlineImagePart | null {
  const src = token.attributes.src ?? "";
  if (!SAFE_IMAGE_SRC_RE.test(src)) {
    return null;
  }

  return {
    kind: "inlineImage",
    alt: token.attributes.alt ?? "",
    src,
    ...(href ? { href } : {}),
    ...parseImageDimensions(token.attributes),
  };
}

function parseImageDimensions(attributes: Record<string, string>): MarkdownImageDimensions {
  return {
    ...parseImageDimension("width", attributes.width),
    ...parseImageDimension("height", attributes.height),
  };
}

function parseImageDimension(key: "width" | "height", value: string | undefined) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
    return {};
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? { [key]: parsed } : {};
}

function safeHref(href: string | undefined): string | undefined {
  if (!href || href === "#" || !SAFE_LINK_HREF_RE.test(href)) {
    return undefined;
  }
  return href;
}

function getSingleImageChild(tokens: HtmlToken[]): HtmlTagToken | null {
  const visible = tokens.filter((token) => token.kind !== "comment" && !isWhitespaceText(token));
  return visible.length === 1 && isOpenTag(visible[0], "img") ? visible[0] : null;
}

function renderUnknownTag(token: HtmlTagToken): string {
  if (token.name === "script" || token.name === "style") {
    return "";
  }
  return token.raw;
}

function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/]/g, "\\]");
}

function findNextOpenTag(tokens: HtmlToken[], start: number, name: string): number | null {
  for (let index = start; index < tokens.length; index += 1) {
    if (isOpenTag(tokens[index], name)) {
      return index;
    }
  }
  return null;
}

function findMatchingClose(tokens: HtmlToken[], openIndex: number, name: string): number | null {
  let depth = 1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOpenTag(token, name) && !token.selfClosing) {
      depth += 1;
      continue;
    }
    if (isClosingTag(token, name)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function isOpenTag(token: HtmlToken | undefined, name: string): token is HtmlTagToken {
  return token?.kind === "tag" && token.name === name && !token.closing;
}

function isClosingTag(token: HtmlToken | undefined, name: string): token is HtmlTagToken {
  return token?.kind === "tag" && token.name === name && token.closing;
}

function isHeadingTag(token: HtmlToken | undefined): token is HtmlTagToken {
  return token?.kind === "tag" && isHeadingTagName(token.name) && !token.closing;
}

function isHeadingTagName(name: string): boolean {
  return (
    name === "h1" ||
    name === "h2" ||
    name === "h3" ||
    name === "h4" ||
    name === "h5" ||
    name === "h6"
  );
}

function isWhitespaceText(token: HtmlToken): boolean {
  return token.kind === "text" && token.value.trim() === "";
}

function tokenizeHtmlishMarkdown(source: string): HtmlToken[] {
  const protectedRanges = getProtectedMarkdownRanges(source);
  const tokens: HtmlToken[] = [];
  const parser = createHtmlishTokenParser(source, tokens);
  let cursor = 0;

  for (const range of protectedRanges) {
    parser.write(source.slice(cursor, range.start));
    tokens.push({ kind: "text", value: source.slice(range.start, range.end) });
    parser.skip(range.end - range.start);
    cursor = range.end;
  }

  parser.write(source.slice(cursor));
  parser.end();
  return tokens;
}

function createHtmlishTokenParser(source: string, tokens: HtmlToken[]): HtmlishTokenParser {
  let stripNextLeadingLineBreak = false;
  let skippedLength = 0;
  let parser!: Parser;
  parser = new Parser(
    {
      onopentag(name, attributes, isImplied) {
        if (isImplied) {
          return;
        }
        const selfClosing = VOID_HTML_TAGS.has(name);
        tokens.push({
          kind: "tag",
          name,
          closing: false,
          selfClosing,
          attributes,
          raw: renderStartTag(name, attributes),
        });
      },
      onclosetag(name, isImplied) {
        if (isImplied || VOID_HTML_TAGS.has(name)) {
          return;
        }
        tokens.push({
          kind: "tag",
          name,
          closing: true,
          selfClosing: false,
          attributes: {},
          raw: `</${name}>`,
        });
      },
      ontext(value) {
        if (stripNextLeadingLineBreak) {
          stripNextLeadingLineBreak = false;
          value = stripLeadingLineBreak(value);
        }
        if (!value) {
          return;
        }
        tokens.push({ kind: "text", value });
      },
      oncomment() {
        stripNextLeadingLineBreak = isLineStart(source, parser.startIndex + skippedLength);
        tokens.push({ kind: "comment" });
      },
    },
    {
      decodeEntities: false,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    },
  );
  return {
    write(chunk) {
      parser.write(chunk);
    },
    skip(length) {
      skippedLength += length;
    },
    end() {
      parser.end();
    },
  };
}

function isLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === "\n" || source[index - 1] === "\r";
}

function stripLeadingLineBreak(value: string): string {
  if (value.startsWith("\r\n")) {
    return value.slice(2);
  }
  if (value.startsWith("\n") || value.startsWith("\r")) {
    return value.slice(1);
  }
  return value;
}

function renderStartTag(name: string, attributes: Record<string, string>): string {
  const renderedAttributes = Object.entries(attributes)
    .map(([key, value]) => (value === "" ? ` ${key}` : ` ${key}="${escapeAttribute(value)}"`))
    .join("");
  return `<${name}${renderedAttributes}>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function getProtectedMarkdownRanges(source: string): ProtectedMarkdownRange[] {
  const fencedRanges = getFencedCodeRanges(source);
  return mergeProtectedRanges([...fencedRanges, ...getInlineCodeRanges(source, fencedRanges)]);
}

function getFencedCodeRanges(source: string): ProtectedMarkdownRange[] {
  const ranges: ProtectedMarkdownRange[] = [];
  FENCE_LINE_RE.lastIndex = 0;

  while (true) {
    const open = FENCE_LINE_RE.exec(source);
    if (!open) {
      return ranges;
    }

    const marker = open[1];
    if (!marker) {
      continue;
    }

    const close = findClosingFence(source, FENCE_LINE_RE.lastIndex, marker);
    if (!close) {
      ranges.push({ start: open.index, end: source.length });
      return ranges;
    }

    ranges.push({ start: open.index, end: close.end });
    FENCE_LINE_RE.lastIndex = close.end;
  }
}

function findClosingFence(
  source: string,
  start: number,
  marker: string,
): MarkdownDelimiterMatch | null {
  const closeRe = new RegExp(
    `^ {0,3}[${marker[0]}]{${marker.length},}[^\\n\\r]*(?:\\r?\\n|$)`,
    "gm",
  );
  closeRe.lastIndex = start;
  const close = closeRe.exec(source);
  return close ? { index: close.index, end: closeRe.lastIndex } : null;
}

function getInlineCodeRanges(
  source: string,
  fencedRanges: ProtectedMarkdownRange[],
): ProtectedMarkdownRange[] {
  const ranges: ProtectedMarkdownRange[] = [];
  BACKTICK_RUN_RE.lastIndex = 0;

  while (true) {
    const open = BACKTICK_RUN_RE.exec(source);
    if (!open) {
      return ranges;
    }
    if (isProtectedIndex(open.index, fencedRanges)) {
      continue;
    }

    const marker = open[0];
    const afterOpen = BACKTICK_RUN_RE.lastIndex;
    const close = findClosingBacktickRun(source, afterOpen, marker, fencedRanges);
    if (!close) {
      // Unmatched backtick run — skip past it so the loop doesn't restart from 0.
      // findClosingBacktickRun exhausts the global regex, which resets lastIndex
      // to 0 when exec() returns null (ECMAScript §22.2.7.2).
      BACKTICK_RUN_RE.lastIndex = afterOpen;
      continue;
    }

    ranges.push({ start: open.index, end: close.end });
    BACKTICK_RUN_RE.lastIndex = close.end;
  }
}

function findClosingBacktickRun(
  source: string,
  start: number,
  marker: string,
  fencedRanges: ProtectedMarkdownRange[],
): MarkdownDelimiterMatch | null {
  BACKTICK_RUN_RE.lastIndex = start;

  while (true) {
    const close = BACKTICK_RUN_RE.exec(source);
    if (!close) {
      return null;
    }
    if (close[0] === marker && !isProtectedIndex(close.index, fencedRanges)) {
      return { index: close.index, end: BACKTICK_RUN_RE.lastIndex };
    }
  }
}

function mergeProtectedRanges(ranges: ProtectedMarkdownRange[]): ProtectedMarkdownRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ProtectedMarkdownRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}

function isProtectedIndex(index: number, ranges: ProtectedMarkdownRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function normalizeHtmlishMarkdown(source: string): string {
  return renderInlineTokens(tokenizeHtmlishMarkdown(source));
}
