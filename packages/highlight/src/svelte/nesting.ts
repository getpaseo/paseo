import {
  parseMixed,
  type Input,
  type NestedParse,
  type Parser,
  type SyntaxNodeRef,
} from "@lezer/common";
import { parser as cssParser } from "@lezer/css";
import { parser as jsParser } from "@lezer/javascript";
import { LongExpression, ScriptText, ShortExpression, StyleText, TextareaText } from "./terms.js";

export interface NestedLang {
  tag: "script" | "style" | "textarea";
  attrs?: (attrs: Record<string, string>) => boolean;
  parser: Parser;
}

const expressionParser = jsParser.configure({ top: "SingleExpression" });

export const defaultNesting: NestedLang[] = [
  {
    tag: "script",
    attrs: (attrs) => attrs.type === "text/typescript" || attrs.lang === "ts",
    parser: jsParser.configure({ dialect: "ts" }),
  },
  {
    tag: "script",
    attrs(attrs) {
      return (
        !attrs.type ||
        /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^module$|^$/i.test(attrs.type)
      );
    },
    parser: jsParser,
  },
  {
    tag: "style",
    attrs(attrs) {
      return (
        (!attrs.lang || attrs.lang === "css" || attrs.lang === "scss") &&
        (!attrs.type || /^(text\/)?(x-)?(stylesheet|css|scss)$/i.test(attrs.type))
      );
    },
    parser: cssParser,
  },
];

function getAttrs(element: SyntaxNodeRef, input: Input): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const firstChild = element.node.firstChild;
  if (!firstChild) return attrs;
  for (const att of firstChild.getChildren("Attribute")) {
    const name = att.getChild("AttributeName");
    const value = att.getChild("AttributeValue") || att.getChild("UnquotedAttributeValue");
    if (name) {
      const attrName = input.read(name.from, name.to);
      if (!value) {
        attrs[attrName] = "";
      } else if (value.name === "AttributeValue") {
        attrs[attrName] = input.read(value.from + 1, value.to - 1);
      } else {
        attrs[attrName] = input.read(value.from, value.to);
      }
    }
  }
  return attrs;
}

function maybeNest(node: SyntaxNodeRef, input: Input, tags: NestedLang[]): NestedParse | null {
  let attrs: Record<string, string> | undefined;
  const parent = node.node.parent;
  if (!parent) return null;
  for (const tag of tags) {
    if (!tag.attrs || tag.attrs(attrs || (attrs = getAttrs(parent, input)))) {
      return { parser: tag.parser };
    }
  }
  return null;
}

export function configureNesting(tags: NestedLang[]) {
  const script: NestedLang[] = [];
  const style: NestedLang[] = [];
  const textarea: NestedLang[] = [];
  for (const tag of tags) {
    let array: NestedLang[];
    if (tag.tag === "script") {
      array = script;
    } else if (tag.tag === "style") {
      array = style;
    } else if (tag.tag === "textarea") {
      array = textarea;
    } else {
      throw new RangeError("Only script, style, and textarea tags can host nested parsers");
    }
    array.push(tag);
  }
  return parseMixed((node, input) => {
    const id = node.type.id;
    if (id === LongExpression || id === ShortExpression) return { parser: expressionParser };
    if (id === ScriptText) return maybeNest(node, input, script);
    if (id === StyleText) return maybeNest(node, input, style);
    if (id === TextareaText) return maybeNest(node, input, textarea);
    return null;
  });
}
