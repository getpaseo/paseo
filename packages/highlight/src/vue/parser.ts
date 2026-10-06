import {
  type Input,
  type NestedParse,
  type SyntaxNode,
  type SyntaxNodeRef,
  parseMixed,
} from "@lezer/common";
import { parser as cssParser } from "@lezer/css";
import { parser as htmlParser } from "@lezer/html";
import { parser as jsParser } from "@lezer/javascript";

interface Range {
  from: number;
  to: number;
}

const typescriptParser = jsParser.configure({ dialect: "ts" });
const expressionParser = jsParser.configure({ top: "SingleExpression" });

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

// Template strings nested deeper than this are treated as running to the end.
const MAX_TEMPLATE_NESTING = 32;

function skipQuotedText(text: string, opening: number, nesting = 0): number {
  const quote = text.charCodeAt(opening);
  for (let position = opening + 1; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 92) position++;
    else if (code === quote) return position;
    else if (quote === 96 && code === 36 && text.charCodeAt(position + 1) === 123) {
      position = skipTemplateSubstitution(text, position + 2, nesting);
    }
  }
  return text.length - 1;
}

function skipTemplateSubstitution(text: string, start: number, nesting: number): number {
  if (nesting >= MAX_TEMPLATE_NESTING) return text.length - 1;
  const closing = findClosingBrace(text, start, () => true, nesting + 1);
  return closing >= 0 ? closing : text.length - 1;
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

// Finds the first `}` outside nested braces, strings, comments, and regexes
// for which `isEnd` holds.
function findClosingBrace(
  text: string,
  start: number,
  isEnd: (position: number) => boolean,
  nesting = 0,
): number {
  let depth = 0;
  for (let position = start; position < text.length; position++) {
    const code = text.charCodeAt(position);
    if (code === 47 && text.charCodeAt(position + 1) === 47) {
      position = skipLineComment(text, position);
    } else if (code === 47 && text.charCodeAt(position + 1) === 42) {
      position = skipBlockComment(text, position);
    } else if (code === 47 && isRegexStart(text, position)) {
      position = skipRegex(text, position);
    } else if (code === 34 || code === 39 || code === 96) {
      position = skipQuotedText(text, position, nesting);
    } else if (code === 123) {
      depth++;
    } else if (code === 125 && depth === 0) {
      if (isEnd(position)) return position;
    } else if (code === 125) {
      depth--;
    }
  }
  return -1;
}

function findInterpolationEnd(text: string, start: number): number {
  return findClosingBrace(text, start, (position) => text.charCodeAt(position + 1) === 125);
}

function findExpressions(text: string): Range[] {
  const ranges: Range[] = [];
  for (let position = 0; position < text.length; position++) {
    if (text.charCodeAt(position) !== 123) continue;
    if (text.charCodeAt(position + 1) !== 123) continue;
    const closing = findInterpolationEnd(text, position + 2);
    if (closing < 0) break;
    // Lezer rejects empty inner ranges, so `{{}}` gets no nested parse.
    if (closing > position + 2) ranges.push({ from: position + 2, to: closing });
    position = closing + 1;
  }
  return ranges;
}

function findDirectiveExpression(value: string): Range | null {
  const quote = value[0];
  const isQuoted = (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote);
  const inner = isQuoted ? value.slice(1, -1) : value;
  const trimmed = inner.trim();
  if (!trimmed) return null;
  const from = (isQuoted ? 1 : 0) + inner.indexOf(trimmed);
  return { from, to: from + trimmed.length };
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

function isDirectiveAttribute(attribute: string): boolean {
  return (
    attribute.startsWith("v-") ||
    attribute.startsWith(":") ||
    attribute.startsWith("@") ||
    attribute.startsWith(".")
  );
}

function directiveOverlay(
  node: SyntaxNodeRef,
  parent: SyntaxNode,
  input: Input,
): NestedParse | null {
  const attributeName = parent.getChild("AttributeName");
  if (!attributeName) return null;
  if (!isDirectiveAttribute(input.read(attributeName.from, attributeName.to).toLowerCase())) {
    return null;
  }

  const range = findDirectiveExpression(input.read(node.from, node.to));
  if (!range) return null;
  return {
    parser: expressionParser,
    overlay: [{ from: node.from + range.from, to: node.from + range.to }],
  };
}

function textOverlay(node: SyntaxNodeRef, input: Input): NestedParse | null {
  const overlays = findExpressions(input.read(node.from, node.to)).map(({ from, to }) => ({
    from: node.from + from,
    to: node.from + to,
  }));
  return overlays.length > 0 ? { parser: expressionParser, overlay: overlays } : null;
}

function templateOverlay(node: SyntaxNodeRef, input: Input): NestedParse | null {
  const parent = node.node.parent;
  if (parent?.name === "Attribute") return directiveOverlay(node, parent, input);
  if (node.name !== "Text") return null;
  return textOverlay(node, input);
}

function scriptLanguage(attributes: Record<string, string>): NestedParse | null {
  if (attributes.src) return null;

  const language = (attributes.lang || attributes.type || "").toLowerCase();
  if (language.includes("tsx")) return { parser: jsParser.configure({ dialect: "ts jsx" }) };
  if (language.includes("typescript") || language === "ts") return { parser: typescriptParser };
  if (language.includes("jsx")) return { parser: jsParser.configure({ dialect: "jsx" }) };
  return { parser: jsParser };
}

function scriptOverlay(node: SyntaxNodeRef, input: Input): NestedParse | null {
  const parent = node.node.parent;
  if (!parent) return null;
  return scriptLanguage(getOpenTagAttributes(parent, input));
}

function nestedLanguage(node: SyntaxNodeRef, input: Input): NestedParse | null {
  const name = node.name;
  if (name === "Text" || name === "UnquotedAttributeValue" || name === "AttributeValue") {
    return templateOverlay(node, input);
  }
  if (name === "StyleText") return { parser: cssParser };
  if (name === "ScriptText") return scriptOverlay(node, input);
  return null;
}

export const vueParser = htmlParser.configure({
  wrap: parseMixed(nestedLanguage),
});
