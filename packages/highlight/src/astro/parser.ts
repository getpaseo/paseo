// Adapted from @fazelstudio/codemirror-lang-astro@0.2.0 (MIT).
// The parser is kept pure so server-side diff highlighting does not load editor-only modules.
import {
  type Input,
  type NestedParse,
  type PartialParse,
  Parser,
  parseMixed,
  type SyntaxNode,
  type SyntaxNodeRef,
  type Tree,
  type TreeFragment,
} from "@lezer/common";
import { parser as cssParser } from "@lezer/css";
import { parser as htmlParser } from "@lezer/html";
import { parser as jsParser } from "@lezer/javascript";

interface Range {
  from: number;
  to: number;
}

const jsxParser = jsParser.configure({ dialect: "ts jsx" });
const typescriptParser = jsParser.configure({ dialect: "ts" });

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isRegexStart(text: string, position: number): boolean {
  let previous = position - 1;
  while (previous >= 0 && isSpace(text.charCodeAt(previous))) previous--;
  if (previous < 0) return true;

  const character = text[previous];
  if (/[)\]}<"'`\d]/.test(character)) return false;
  const code = text.charCodeAt(previous);
  if (code === 62) return previous > 0 && text.charCodeAt(previous - 1) === 61;
  if (!/[A-Za-z_$]/.test(character)) return true;

  let start = previous;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start--;
  const keyword = text.slice(start + 1, previous + 1);
  return /^(return|typeof|instanceof|in|of|new|void|delete|yield|await|case|do|else|throw|extends|assert|with)$/.test(
    keyword,
  );
}

function skipQuotedText(text: string, opening: number): number {
  const quote = text.charCodeAt(opening);
  for (let position = opening + 1; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 92) position++;
    else if (code === quote) return position;
  }
  return text.length - 1;
}

function skipLineComment(text: string, opening: number): number {
  const newline = text.indexOf("\n", opening + 2);
  return newline >= 0 ? newline : text.length - 1;
}

function skipBlockComment(text: string, opening: number): number {
  const closing = text.indexOf("*/", opening + 2);
  return closing >= 0 ? closing + 1 : text.length - 1;
}

function skipRegex(text: string, opening: number): number {
  let isInCharacterClass = false;
  for (let position = opening + 1; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 10 || code === 13) return position;
    if (code === 92) position++;
    else if (isInCharacterClass && code === 93) isInCharacterClass = false;
    else if (!isInCharacterClass && code === 91) isInCharacterClass = true;
    else if (!isInCharacterClass && code === 47) return position;
  }
  return text.length - 1;
}

function findClosingBrace(text: string, opening: number): number {
  let depth = 0;
  for (let position = opening; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 47 && text.charCodeAt(position + 1) === 47) {
      position = skipLineComment(text, position);
    } else if (code === 47 && text.charCodeAt(position + 1) === 42) {
      position = skipBlockComment(text, position);
    } else if (code === 47 && isRegexStart(text, position)) {
      position = skipRegex(text, position);
    } else if (code === 34 || code === 39 || code === 96) {
      position = skipQuotedText(text, position);
    } else if (code === 123) {
      depth++;
    } else if (code === 125 && --depth === 0) {
      return position;
    }
  }
  return -1;
}

function findExpressions(text: string): Range[] {
  const ranges: Range[] = [];
  for (let position = 0; position < text.length; position++) {
    if (text.charCodeAt(position) !== 123) continue;
    const closing = findClosingBrace(text, position);
    if (closing < 0) break;
    ranges.push({ from: position, to: closing });
    position = closing;
  }
  return ranges;
}

function maskExpressions(text: string): string {
  const characters = text.split("");
  for (const { from, to } of findExpressions(text)) {
    for (let position = from + 1; position < to; position++) characters[position] = "a";
  }
  return characters.join("");
}

function expressionOverlays(node: SyntaxNodeRef, input: Input): Range[] | null {
  const overlays = findExpressions(input.read(node.from, node.to)).map(({ from, to }) => ({
    from: node.from + from + 1,
    to: node.from + to,
  }));
  return overlays.length > 0 ? overlays : null;
}

function isFenceEnd(text: string, position: number): boolean {
  if (position >= text.length) return true;
  const code = text.charCodeAt(position);
  return code === 10 || code === 13 || code === 32 || code === 9;
}

function findFrontmatter(text: string): Range | null {
  const from = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", from) || !isFenceEnd(text, from + 3)) return null;

  let newline = text.indexOf("\n", from + 3);
  while (newline >= 0) {
    const closing = newline + 1;
    if (text.startsWith("---", closing) && isFenceEnd(text, closing + 3)) {
      return { from, to: closing + 3 };
    }
    newline = text.indexOf("\n", closing);
  }
  return null;
}

function maskDocument(text: string, frontmatter: Range | null): string {
  if (!frontmatter) return maskExpressions(text);
  return (
    text.slice(0, frontmatter.from) +
    "<!--" +
    text.slice(frontmatter.from + 4, frontmatter.to - 3) +
    "-->" +
    maskExpressions(text.slice(frontmatter.to))
  );
}

function getOpenTagAttributes(node: SyntaxNode, input: Input): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  const openTag = node.getChild("OpenTag");
  if (!openTag) return attributes;

  for (const attribute of openTag.getChildren("Attribute")) {
    const name = attribute.getChild("AttributeName");
    if (!name) continue;
    const value =
      attribute.getChild("AttributeValue") || attribute.getChild("UnquotedAttributeValue");
    const key = input.read(name.from, name.to).toLowerCase();
    attributes[key] = value ? input.read(value.from, value.to).replace(/^["']|["']$/g, "") : "";
  }
  return attributes;
}

function nestedLanguage(node: SyntaxNodeRef, input: Input): NestedParse | null {
  if (node.name === "Comment") {
    const isFrontmatter =
      input.read(node.from, node.from + 3) === "---" && input.read(node.to - 3, node.to) === "---";
    const from = node.from + 4;
    const to = node.to - 3;
    return isFrontmatter && to > from
      ? { parser: typescriptParser, overlay: [{ from, to }] }
      : null;
  }

  const canContainExpression =
    node.name === "Text" ||
    node.name === "UnquotedAttributeValue" ||
    node.name === "AttributeValue";
  if (canContainExpression) {
    const overlay = expressionOverlays(node, input);
    return overlay ? { parser: jsxParser, overlay } : null;
  }
  if (node.name === "StyleText") return { parser: cssParser };
  if (node.name !== "ScriptText" || !node.node.parent) return null;

  const attributes = getOpenTagAttributes(node.node.parent, input);
  if (attributes.src) return null;
  const language = (attributes.lang || attributes.type || "").toLowerCase();
  let dialect = "";
  if (language.includes("tsx")) dialect = "ts jsx";
  else if (language.includes("typescript") || language === "ts") dialect = "ts";
  else if (language.includes("jsx")) dialect = "jsx";
  return { parser: dialect ? jsParser.configure({ dialect }) : jsParser };
}

class CompletedParse implements PartialParse {
  private isDone = false;

  constructor(private readonly tree: Tree) {}

  advance(): Tree | null {
    if (this.isDone) return null;
    this.isDone = true;
    return this.tree;
  }

  get parsedPos(): number {
    return this.tree.length;
  }

  stopAt(): void {}

  get stoppedAt(): null {
    return null;
  }
}

const mountNestedLanguages = parseMixed(nestedLanguage);

class AstroParser extends Parser {
  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly Range[],
  ): PartialParse {
    const from = ranges[0]?.from ?? 0;
    const to = ranges[0]?.to ?? input.length;
    const text = input.read(from, to);
    const tree = htmlParser.parse(maskDocument(text, findFrontmatter(text)));
    return mountNestedLanguages(new CompletedParse(tree), input, fragments, ranges);
  }
}

export const astroParser = new AstroParser();
