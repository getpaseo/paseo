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
}

export type MarkdownDisplayPart = MarkdownTextPart | MarkdownDetailsPart | MarkdownInlineImagePart;

const FENCE_LINE_RE = /^ {0,3}([`~]{3,})[^\n\r]*(?:\r?\n|$)/gm;
const BACKTICK_RUN_RE = /`+/g;
const SAFE_IMAGE_SRC_RE = /^(https?:\/\/|data:image\/(?:png|gif|jpe?g);base64,)/i;
const SAFE_LINK_HREF_RE = /^(https?:\/\/|#(?:$|[\w-]))/i;

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

interface HtmlTokenParseResult {
  token: HtmlToken;
  end: number;
}

interface HtmlAttributeParseResult {
  name: string;
  value: string;
  end: number;
}

interface MarkdownDelimiterMatch {
  index: number;
  end: number;
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
      parts.push(inlineImage.part);
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
  return token?.kind === "tag" && /^h[1-6]$/.test(token.name) && !token.closing;
}

function isWhitespaceText(token: HtmlToken): boolean {
  return token.kind === "text" && token.value.trim() === "";
}

function tokenizeHtmlishMarkdown(source: string): HtmlToken[] {
  const protectedRanges = getProtectedMarkdownRanges(source);
  const tokens: HtmlToken[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const protectedRange = findProtectedRangeAt(cursor, protectedRanges);
    if (protectedRange) {
      tokens.push({ kind: "text", value: source.slice(cursor, protectedRange.end) });
      cursor = protectedRange.end;
      continue;
    }

    const nextProtectedRange = findNextProtectedRange(cursor, protectedRanges);
    const nextTagStart = source.indexOf("<", cursor);
    if (nextTagStart === -1 || (nextProtectedRange && nextProtectedRange.start < nextTagStart)) {
      const end = nextProtectedRange?.start ?? source.length;
      tokens.push({ kind: "text", value: source.slice(cursor, end) });
      cursor = end;
      continue;
    }

    if (nextTagStart > cursor) {
      tokens.push({ kind: "text", value: source.slice(cursor, nextTagStart) });
    }

    const parsed = parseHtmlTokenAt(source, nextTagStart);
    if (!parsed) {
      tokens.push({ kind: "text", value: "<" });
      cursor = nextTagStart + 1;
      continue;
    }

    tokens.push(parsed.token);
    cursor = parsed.end;
  }

  return tokens;
}

function parseHtmlTokenAt(source: string, start: number): HtmlTokenParseResult | null {
  if (source.startsWith("<!--", start)) {
    const close = source.indexOf("-->", start + 4);
    if (close === -1) {
      return null;
    }
    return { token: { kind: "comment" }, end: getCommentEnd(source, start, close + 3) };
  }

  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === "/") {
    closing = true;
    cursor += 1;
  }

  cursor = skipWhitespace(source, cursor);
  const nameStart = cursor;
  while (cursor < source.length && isTagNameCharacter(source[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }

  const name = source.slice(nameStart, cursor).toLowerCase();
  const attributes: Record<string, string> = {};
  let selfClosing = false;

  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    const char = source[cursor];
    if (char === ">") {
      const end = cursor + 1;
      return {
        token: {
          kind: "tag",
          name,
          closing,
          selfClosing,
          attributes,
          raw: source.slice(start, end),
        },
        end,
      };
    }
    if (char === "/" && source[cursor + 1] === ">") {
      selfClosing = true;
      const end = cursor + 2;
      return {
        token: {
          kind: "tag",
          name,
          closing,
          selfClosing,
          attributes,
          raw: source.slice(start, end),
        },
        end,
      };
    }
    if (char === undefined || closing) {
      return null;
    }

    const attribute = parseAttribute(source, cursor);
    if (!attribute) {
      return null;
    }
    attributes[attribute.name] = attribute.value;
    cursor = attribute.end;
  }

  return null;
}

function getCommentEnd(source: string, start: number, defaultEnd: number): number {
  const startsLine = start === 0 || source[start - 1] === "\n" || source[start - 1] === "\r";
  if (!startsLine) {
    return defaultEnd;
  }
  if (source.startsWith("\r\n", defaultEnd)) {
    return defaultEnd + 2;
  }
  if (source[defaultEnd] === "\n" || source[defaultEnd] === "\r") {
    return defaultEnd + 1;
  }
  return defaultEnd;
}

function parseAttribute(source: string, start: number): HtmlAttributeParseResult | null {
  let cursor = start;
  const nameStart = cursor;
  while (cursor < source.length && isAttributeNameCharacter(source[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }

  const name = source.slice(nameStart, cursor).toLowerCase();
  cursor = skipWhitespace(source, cursor);
  if (source[cursor] !== "=") {
    return { name, value: "", end: cursor };
  }

  cursor = skipWhitespace(source, cursor + 1);
  const quote = source[cursor];
  if (quote === '"' || quote === "'") {
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) {
      return null;
    }
    return { name, value: source.slice(valueStart, valueEnd), end: valueEnd + 1 };
  }

  const valueStart = cursor;
  while (cursor < source.length && !isWhitespace(source[cursor]) && source[cursor] !== ">") {
    cursor += 1;
  }
  return { name, value: source.slice(valueStart, cursor), end: cursor };
}

function isTagNameCharacter(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9:-]/.test(char));
}

function isAttributeNameCharacter(char: string | undefined): boolean {
  return Boolean(char && /[^\s=/>]/.test(char));
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && isWhitespace(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
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
    const close = findClosingBacktickRun(source, BACKTICK_RUN_RE.lastIndex, marker, fencedRanges);
    if (!close) {
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
  const sorted = ranges.toSorted((a, b) => a.start - b.start);
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

function findProtectedRangeAt(
  index: number,
  ranges: ProtectedMarkdownRange[],
): ProtectedMarkdownRange | null {
  return ranges.find((range) => index >= range.start && index < range.end) ?? null;
}

function findNextProtectedRange(
  index: number,
  ranges: ProtectedMarkdownRange[],
): ProtectedMarkdownRange | null {
  return ranges.find((range) => range.start > index) ?? null;
}

function isProtectedIndex(index: number, ranges: ProtectedMarkdownRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function normalizeHtmlishMarkdown(source: string): string {
  return renderInlineTokens(tokenizeHtmlishMarkdown(source));
}
