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
import { findClosingBrace } from "../js-scanner.js";

interface Range {
  from: number;
  to: number;
}

const typescriptParser = jsParser.configure({ dialect: "ts" });
const expressionParser = jsParser.configure({ top: "SingleExpression" });

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
