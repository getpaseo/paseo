import { HighlightStyle as CodeMirrorHighlightStyle } from "@codemirror/language";
import { tagHighlighter, tags, type Tag } from "@lezer/highlight";
import type { HighlightStyle } from "./types.js";

export const syntaxRoleTags: ReadonlyArray<{ tag: Tag; role: HighlightStyle }> = [
  { tag: tags.keyword, role: "keyword" },
  { tag: tags.controlKeyword, role: "keyword" },
  { tag: tags.operatorKeyword, role: "keyword" },
  { tag: tags.definitionKeyword, role: "keyword" },
  { tag: tags.moduleKeyword, role: "keyword" },
  { tag: tags.comment, role: "comment" },
  { tag: tags.lineComment, role: "comment" },
  { tag: tags.blockComment, role: "comment" },
  { tag: tags.docComment, role: "comment" },
  { tag: tags.string, role: "string" },
  { tag: tags.special(tags.string), role: "string" },
  { tag: tags.number, role: "number" },
  { tag: tags.integer, role: "number" },
  { tag: tags.float, role: "number" },
  { tag: tags.bool, role: "literal" },
  { tag: tags.null, role: "literal" },
  { tag: tags.function(tags.variableName), role: "function" },
  { tag: tags.function(tags.propertyName), role: "function" },
  { tag: tags.definition(tags.variableName), role: "definition" },
  { tag: tags.definition(tags.propertyName), role: "definition" },
  { tag: tags.definition(tags.function(tags.variableName)), role: "definition" },
  { tag: tags.className, role: "class" },
  { tag: tags.definition(tags.className), role: "class" },
  { tag: tags.typeName, role: "type" },
  { tag: tags.tagName, role: "tag" },
  { tag: tags.attributeName, role: "attribute" },
  { tag: tags.attributeValue, role: "string" },
  { tag: tags.propertyName, role: "property" },
  { tag: tags.variableName, role: "variable" },
  { tag: tags.local(tags.variableName), role: "variable" },
  { tag: tags.special(tags.variableName), role: "variable" },
  { tag: tags.operator, role: "operator" },
  { tag: tags.punctuation, role: "punctuation" },
  { tag: tags.bracket, role: "punctuation" },
  { tag: tags.separator, role: "punctuation" },
  { tag: tags.regexp, role: "regexp" },
  { tag: tags.escape, role: "escape" },
  { tag: tags.meta, role: "meta" },
  { tag: tags.heading, role: "heading" },
  { tag: tags.link, role: "link" },
  { tag: tags.url, role: "link" },
];

export const staticSyntaxHighlighter = tagHighlighter(
  syntaxRoleTags.map(({ tag, role }) => ({ tag, class: role })),
);

export function createCodeMirrorHighlightStyle(colors: Record<HighlightStyle, string>) {
  return CodeMirrorHighlightStyle.define(
    syntaxRoleTags.map(({ tag, role }) => ({ tag, color: colors[role] })),
  );
}
