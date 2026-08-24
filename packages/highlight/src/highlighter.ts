import { highlightTree } from "@lezer/highlight";
import type { HighlightStyle, HighlightToken } from "./types.js";
import { getParserForFile } from "./parsers.js";

import { staticSyntaxHighlighter } from "./syntax-roles.js";

export function highlightCode(code: string, filename: string): HighlightToken[][] {
  const parser = getParserForFile(filename);

  if (!parser) {
    return code.split("\n").map((line) => [{ text: line, style: null }]);
  }

  const tree = parser.parse(code);
  const lines = code.split("\n");
  const result: HighlightToken[][] = [];

  for (let i = 0; i < lines.length; i++) {
    result.push([]);
  }

  // Build a map of character positions to styles
  const styleMap: Array<HighlightStyle | null> = Array.from({ length: code.length }, () => null);

  highlightTree(tree, staticSyntaxHighlighter, (from, to, classes) => {
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
