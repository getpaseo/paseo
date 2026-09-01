// Shared bits of the Paseo UI, drawn small. Everything here is presentational —
// no state, no interactivity. Colors come from the `--color-mock-*` tokens in
// styles.css, which are copied from the app's default dark theme.

import type * as React from "react";

/**
 * The `+12 −18` footnote. A diff stat is a *status* signal, not a diff, so it
 * uses statusSuccess/statusDanger — see the comment above `lightDiffColors` in
 * packages/app/src/styles/theme.ts.
 */
export function DiffStat({ add, remove }: { add: string; remove: string }) {
  return (
    <span className="flex shrink-0 items-center gap-[4px] text-[11px] tabular-nums">
      <span className="text-mock-success">+{add}</span>
      <span className="text-mock-danger">-{remove}</span>
    </span>
  );
}

export type DotTone = "success" | "danger" | "warning" | "running" | "idle";

const DOT_TONE: Record<DotTone, string> = {
  success: "bg-mock-dot-success",
  danger: "bg-mock-dot-danger",
  warning: "bg-mock-dot-warning",
  running: "bg-mock-dot-running",
  idle: "bg-mock-surface3",
};

/** The 6pt disc on a sidebar row that carries the row's state. */
export function StatusDot({ tone }: { tone: DotTone }) {
  return <span className={`size-[7px] shrink-0 rounded-full ${DOT_TONE[tone]}`} />;
}

/** Stands in for the dot on a running row — three stacked ticks, warning hue. */
export function WorkingGlyph() {
  return (
    <span className="flex h-[10px] w-[7px] shrink-0 flex-col items-center justify-between">
      <i className="block size-[2.5px] rounded-full bg-mock-dot-warning" />
      <i className="block size-[2.5px] rounded-full bg-mock-dot-warning" />
      <i className="block size-[2.5px] rounded-full bg-mock-dot-warning" />
    </span>
  );
}

/** A pill-shaped count/label badge — PR number, failing checks, host. */
export function MetaBadge({
  icon,
  children,
  className = "text-mock-fg-xmuted",
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center gap-[3px] text-[10px] ${className}`}>
      {icon}
      {children}
    </span>
  );
}

/** Title-bar / toolbar button: transparent until hovered in the real app. */
export function ChromeButton({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`flex items-center gap-[5px] rounded-[6px] px-[7px] py-[4px] text-[11.5px] text-mock-fg-muted ${className}`}
    >
      {children}
    </span>
  );
}

export function VDivider() {
  return <span className="h-[16px] w-px shrink-0 bg-mock-border" />;
}

// --- code rendering ---------------------------------------------------------

type SynRole =
  | "keyword"
  | "comment"
  | "string"
  | "number"
  | "function"
  | "class"
  | "type"
  | "tag"
  | "property"
  | "variable"
  | "punctuation";

const SYN_CLASS: Record<SynRole, string> = {
  keyword: "text-syn-keyword",
  comment: "text-syn-comment",
  string: "text-syn-string",
  number: "text-syn-number",
  function: "text-syn-function",
  class: "text-mock-syn-class",
  type: "text-syn-keyword",
  tag: "text-syn-tag",
  property: "text-syn-property",
  variable: "text-syn-variable",
  punctuation: "text-syn-punctuation",
};

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "as",
  "function",
  "return",
  "const",
  "let",
  "type",
  "interface",
  "await",
  "async",
  "new",
  "default",
]);

const TYPE_KEYWORDS = new Set(["string", "number", "boolean", "unknown", "never", "void"]);

/** A compact TSX highlighter for the static hero diff. */
export function Code({ line }: { line: string }) {
  return (
    <>
      {tokenize(line).map((token) => (
        <span key={token.key} className={token.role ? SYN_CLASS[token.role] : undefined}>
          {token.text}
        </span>
      ))}
    </>
  );
}

interface CodeToken {
  key: string;
  text: string;
  role: SynRole | null;
}

function tokenize(line: string): CodeToken[] {
  const parts =
    line.match(
      /\/\/.*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\d+(?:\.\d+)?|[A-Za-z_$][\w$-]*|\s+|=>|===|!==|==|!=|<=|>=|&&|\|\||\?\.|[^\s]/g,
    ) ?? [];
  return parts.map((text, index) => {
    const role = classify(parts, index);
    return { key: `${index}.${text}`, text, role };
  });
}

function significantToken(parts: string[], index: number, direction: -1 | 1): string {
  for (let cursor = index + direction; cursor >= 0 && cursor < parts.length; cursor += direction) {
    const candidate = parts[cursor];
    if (candidate && !/^\s+$/.test(candidate)) return candidate;
  }
  return "";
}

function isInsideJsxTag(parts: string[], index: number): boolean {
  const prefix = parts.slice(0, index).join("");
  return prefix.lastIndexOf("<") > prefix.lastIndexOf(">");
}

function classify(parts: string[], index: number): SynRole | null {
  const part = parts[index] ?? "";
  if (/^\s+$/.test(part)) return null;
  if (/^["'`]/.test(part)) return "string";
  if (part.startsWith("//")) return "comment";
  if (KEYWORDS.has(part)) return "keyword";
  if (TYPE_KEYWORDS.has(part)) return "type";
  if (/^\d/.test(part)) return "number";
  if (!/^[A-Za-z_$]/.test(part)) return "punctuation";
  return classifyIdentifier(parts, index, part);
}

function classifyIdentifier(parts: string[], index: number, part: string): SynRole {
  const previous = significantToken(parts, index, -1);
  const next = significantToken(parts, index, 1);
  const insideJsxTag = isInsideJsxTag(parts, index);
  if (previous === "<" || (previous === "/" && insideJsxTag)) return "tag";
  if (insideJsxTag && next === "=") return "property";
  if (!insideJsxTag && next === ":") return "property";
  if (previous === ":" || previous === "as") return "type";
  if (next === "(") return "function";
  if (/^[A-Z]/.test(part)) return "class";
  if (part.includes("-")) return "property";
  return "variable";
}
