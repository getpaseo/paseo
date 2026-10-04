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

function findInterpolationEnd(text: string, start: number): number {
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
      position = skipQuotedText(text, position);
    } else if (code === 123) {
      depth++;
    } else if (code === 125 && depth === 0) {
      if (text.charCodeAt(position + 1) === 125) return position;
    } else if (code === 125) {
      depth--;
    }
  }
  return -1;
}

function findExpressions(text: string): Range[] {
  const ranges: Range[] = [];
  for (let position = 0; position < text.length; position++) {
    if (text.charCodeAt(position) !== 123) continue;
    if (text.charCodeAt(position + 1) !== 123) continue;
    const closing = findInterpolationEnd(text, position + 2);
    if (closing < 0) break;
    ranges.push({ from: position + 2, to: closing });
    position = closing + 1;
  }
  return ranges;
}

function findDirectiveExpression(text: string): Range | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const leading = text.indexOf(trimmed[0]);
  const trailing = leading + trimmed.length;
  if (leading > 0 && /[\w-]/.test(text.charAt(leading - 1))) return null;
  return { from: leading, to: trailing };
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
  const canContainTemplateExpression =
    node.name === "Text" ||
    node.name === "UnquotedAttributeValue" ||
    node.name === "AttributeValue";

  if (canContainTemplateExpression) {
    const parent = node.node.parent;
    const parentName = parent?.name ?? "";

    if (parentName === "Attribute") {
      const attributeName = parent?.getChild("AttributeName");
      if (attributeName) {
        const attr = input.read(attributeName.from, attributeName.to).toLowerCase();
        const isDirective =
          attr.startsWith("v-") ||
          attr.startsWith(":") ||
          attr.startsWith("@") ||
          attr.startsWith(".");
        if (isDirective) {
          const text = input.read(node.from, node.to);
          const range = findDirectiveExpression(text);
          if (range) {
            return {
              parser: expressionParser,
              overlay: [{ from: node.from + range.from, to: node.from + range.to }],
            };
          }
          return null;
        }
      }
      return null;
    }

    if (node.name === "Text") {
      const text = input.read(node.from, node.to);
      const overlays = findExpressions(text).map(({ from, to }) => ({
        from: node.from + from,
        to: node.from + to,
      }));
      if (overlays.length > 0) {
        return { parser: expressionParser, overlay: overlays };
      }
      return null;
    }
  }

  if (node.name === "StyleText") return { parser: cssParser };

  if (node.name === "ScriptText") {
    if (!node.node.parent) return null;
    const attributes = getOpenTagAttributes(node.node.parent, input);
    if (attributes.src) return null;

    const language = (attributes.lang || attributes.type || "").toLowerCase();
    if (language.includes("tsx")) {
      return { parser: jsParser.configure({ dialect: "ts jsx" }) };
    }
    if (language.includes("typescript") || language === "ts") {
      return { parser: typescriptParser };
    }
    if (language.includes("jsx")) {
      return { parser: jsParser.configure({ dialect: "jsx" }) };
    }
    return { parser: jsParser };
  }

  return null;
}

export const vueParser = htmlParser.configure({
  wrap: parseMixed(nestedLanguage),
});
