import { createHash } from "node:crypto";
import { extname } from "node:path";
import ts from "typescript";
import { parse as parseCss, CssSyntaxError } from "postcss";
export interface SourceLine {
  text: string;
  tokens: string[];
  comments: string;
}
interface SourceAnalysis {
  lines: SourceLine[];
  valid: boolean;
}
const sourceCache = new Map<string, SourceAnalysis>();
const MAX_SOURCE_BYTES = 1024 * 1024;

export function analyzeSource(path: string, content: string): SourceAnalysis | null {
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) return null;
  const extension = extname(path).toLowerCase();
  if (!/^(\.[cm]?[jt]s|\.[jt]sx|\.css)$/.test(extension)) return null;
  const key = extension + createHash("sha256").update(content).digest("hex");
  const cached = sourceCache.get(key);
  if (cached) return cached;
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  const lines = content.split("\n").map((text): SourceLine => ({ text, tokens: [], comments: "" }));
  function mark(start: number, end: number, comment: boolean, tag = ""): void {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= start) lo = mid;
      else hi = mid;
    }
    for (let line = lo; line < starts.length && starts[line] < end; line++) {
      const part = content.slice(
        Math.max(start, starts[line]),
        Math.min(end, starts[line + 1] ?? content.length),
      );
      if (comment) lines[line].comments += part;
      else if (part.length) lines[line].tokens.push(tag + JSON.stringify(part));
    }
  }
  let valid = true;
  if (extension === ".css") {
    try {
      const root = parseCss(content, { from: path });
      root.walkRules((rule) => {
        const start = rule.source!.start!;
        // Selector whitespace can change meaning (a :hover versus a:hover).
        // PostCSS owns validity; this signature preserves that whitespace while
        // excluding actual comments without changing quoted attribute values.
        const parts =
          rule.selector.match(
            /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^/"']+|./g,
          ) ?? [];
        const selector = parts
          .filter((part) => !part.startsWith("/*"))
          .join("")
          .trim();
        lines[start.line - 1].tokens.push(`selector:${selector}`);
      });
    } catch (error) {
      if (!(error instanceof CssSyntaxError)) throw error;
      valid = false;
    }
    // CSS strings and escapes own their comment-looking text, including data URLs.
    const lexer =
      /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|[\w-]+|\s+|[^\s]/gy;
    for (const match of content.matchAll(lexer)) {
      const value = match[0];
      if (value.startsWith("/*")) {
        mark(match.index, match.index + value.length, true);
        if (!value.endsWith("*/")) valid = false;
      } else if (!/^\s+$/.test(value)) mark(match.index, match.index + value.length, false);
    }
  } else {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    let cursor = 0;
    function visit(node: ts.Node): void {
      if (node.flags & ts.NodeFlags.ThisNodeHasError) valid = false;
      if (ts.isJSDoc(node) || (ts.isJsxExpression(node) && !node.expression)) {
        mark(cursor, node.end, true);
        cursor = node.end;
        return;
      }
      const children = node.getChildren(source);
      if (children.length) {
        for (const child of children) visit(child);
        return;
      }
      const start = node.getStart(source);
      mark(cursor, start, true);
      // The immediate syntax parent preserves ASI-sensitive return/expression changes.
      if (node.kind !== ts.SyntaxKind.EndOfFileToken)
        mark(start, node.end, false, String(node.parent.kind));
      cursor = node.end;
    }
    visit(source);
    mark(cursor, content.length, true);
  }
  const result = { lines, valid };
  sourceCache.set(key, result);
  if (sourceCache.size > 24) sourceCache.delete(sourceCache.keys().next().value!);
  return result;
}
