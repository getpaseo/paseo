import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as htmlParser } from "@lezer/html";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser } from "@lezer/markdown";
import type { Parser } from "@lezer/common";

// Map file extensions to parsers
const parsersByExtension: Record<string, Parser> = {
  // JavaScript/TypeScript
  js: jsParser,
  jsx: jsParser.configure({ dialect: "jsx" }),
  ts: jsParser.configure({ dialect: "ts" }),
  tsx: jsParser.configure({ dialect: "tsx jsx" }),
  mjs: jsParser,
  cjs: jsParser,
  // JSON
  json: jsonParser,
  // CSS
  css: cssParser,
  scss: cssParser,
  // HTML
  html: htmlParser,
  htm: htmlParser,
  // Python
  py: pythonParser,
  // Markdown
  md: markdownParser,
  mdx: markdownParser,
};

export type HighlightStyle =
  | "keyword"
  | "comment"
  | "string"
  | "number"
  | "literal"
  | "function"
  | "definition"
  | "class"
  | "type"
  | "tag"
  | "attribute"
  | "property"
  | "variable"
  | "operator"
  | "punctuation"
  | "regexp"
  | "escape"
  | "meta"
  | "heading"
  | "link";

export interface HighlightToken {
  text: string;
  style: HighlightStyle | null;
}

// Create highlighter using tagHighlighter
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.controlKeyword, class: "keyword" },
  { tag: tags.operatorKeyword, class: "keyword" },
  { tag: tags.definitionKeyword, class: "keyword" },
  { tag: tags.moduleKeyword, class: "keyword" },
  { tag: tags.comment, class: "comment" },
  { tag: tags.lineComment, class: "comment" },
  { tag: tags.blockComment, class: "comment" },
  { tag: tags.docComment, class: "comment" },
  { tag: tags.string, class: "string" },
  { tag: tags.special(tags.string), class: "string" },
  { tag: tags.number, class: "number" },
  { tag: tags.integer, class: "number" },
  { tag: tags.float, class: "number" },
  { tag: tags.bool, class: "literal" },
  { tag: tags.null, class: "literal" },
  { tag: tags.function(tags.variableName), class: "function" },
  { tag: tags.function(tags.propertyName), class: "function" },
  { tag: tags.definition(tags.variableName), class: "definition" },
  { tag: tags.definition(tags.propertyName), class: "definition" },
  { tag: tags.definition(tags.function(tags.variableName)), class: "definition" },
  { tag: tags.className, class: "class" },
  { tag: tags.definition(tags.className), class: "class" },
  { tag: tags.typeName, class: "type" },
  { tag: tags.tagName, class: "tag" },
  { tag: tags.attributeName, class: "attribute" },
  { tag: tags.attributeValue, class: "string" },
  { tag: tags.propertyName, class: "property" },
  { tag: tags.variableName, class: "variable" },
  { tag: tags.local(tags.variableName), class: "variable" },
  { tag: tags.special(tags.variableName), class: "variable" },
  { tag: tags.operator, class: "operator" },
  { tag: tags.punctuation, class: "punctuation" },
  { tag: tags.bracket, class: "punctuation" },
  { tag: tags.separator, class: "punctuation" },
  { tag: tags.regexp, class: "regexp" },
  { tag: tags.escape, class: "escape" },
  { tag: tags.meta, class: "meta" },
  { tag: tags.heading, class: "heading" },
  { tag: tags.link, class: "link" },
  { tag: tags.url, class: "link" },
]);

function getParserForFile(filename: string): Parser | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return parsersByExtension[ext] ?? null;
}

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const parser = getParserForFile(filename);

  if (!parser) {
    // No parser available, return unhighlighted lines
    return code.split("\n").map((line) => [{ text: line, style: null }]);
  }

  const tree = parser.parse(code);
  const lines = code.split("\n");
  const result: HighlightToken[][] = [];

  // Initialize with unhighlighted content
  for (let i = 0; i < lines.length; i++) {
    result.push([]);
  }

  // Build a map of character positions to styles
  const styleMap: Array<HighlightStyle | null> = new Array(code.length).fill(null);

  // Use highlightTree to populate the style map
  highlightTree(tree, highlighter, (from, to, classes) => {
    for (let i = from; i < to && i < styleMap.length; i++) {
      styleMap[i] = classes as HighlightStyle;
    }
  });

  // Convert style map to tokens per line
  let pos = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    if (line.length === 0) {
      result[lineIndex].push({ text: "", style: null });
      pos++; // skip newline
      continue;
    }

    let currentToken: HighlightToken = { text: "", style: styleMap[pos] };

    for (let i = 0; i < line.length; i++) {
      const charStyle = styleMap[pos + i];
      if (charStyle === currentToken.style) {
        currentToken.text += line[i];
      } else {
        if (currentToken.text) {
          result[lineIndex].push(currentToken);
        }
        currentToken = { text: line[i], style: charStyle };
      }
    }

    if (currentToken.text) {
      result[lineIndex].push(currentToken);
    }

    pos += line.length + 1; // +1 for newline
  }

  return result;
}

export function highlightLine(line: string, filename: string): HighlightToken[] {
  const result = highlightCode(line, filename);
  return result[0] ?? [{ text: line, style: null }];
}

export function getSupportedExtensions(): string[] {
  return Object.keys(parsersByExtension);
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}
