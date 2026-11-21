import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { nonEmptyString, truncateDiffText } from "../tool-call-mapper-utils.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolGrepOutputSchema,
  ToolGlobOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByToolName,
  parseKnownToolDetail,
} from "../tool-call-detail-primitives.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Code Mode wraps MCP (and catalog) tool calls inside the `execute` tool. The
// real tool name only exists in the generated code, as a property chain on
// `tools` — e.g. `tools.hzmcp.memory__write_note(...)` or
// `tools["charlotte"].charlotte_tabs(...)`. Reconstruct the chain to label the
// timeline row with the tool that actually ran.

// Blank out comments and string literals (same length, newlines preserved) so
// label extraction only sees executed code. Template-literal ${...}
// interpolations stay visible: they are evaluated.

function blankRange(params: { chars: string[]; start: number; end: number }) {
  const { chars, start, end } = params;
  for (let i = start; i < end && i < chars.length; i += 1) {
    if (chars[i] !== "\n") {
      chars[i] = " ";
    }
  }
}

// Keywords after which a `/` starts a regex literal instead of division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

// Scanner state: the last significant unmasked code character and the
// identifier/keyword ending at it. Tracked while scanning instead of read
// back from the text, because earlier masking blanks characters and a
// lookback would misread them (e.g. `"100" / 2` after the string is blanked).
// `wordBoundary` marks that whitespace separated the next identifier from the
// current word, so `return await` stays two keywords instead of one joined
// token.
interface MaskState {
  previous: string;
  word: string;
  wordBoundary: boolean;
}

function startsRegexLiteral(state: MaskState): boolean {
  if (state.previous === "") {
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(state.previous)) {
    return REGEX_PRECEDING_KEYWORDS.has(state.word);
  }
  return "([{,;=:!&|?+-*%~^<>".includes(state.previous);
}

// A finished string, template or regex literal is a value: a following `/` is
// division.
function noteValueToken(params: { state: MaskState }) {
  params.state.previous = '"';
  params.state.word = "";
  params.state.wordBoundary = false;
}

function noteCodeCharacter(params: { character: string; state: MaskState }) {
  const { character, state } = params;
  if (/[A-Za-z0-9_$]/.test(character)) {
    state.word = state.wordBoundary ? character : state.word + character;
    state.wordBoundary = false;
  } else {
    state.word = "";
    state.wordBoundary = false;
  }
  state.previous = character;
}

function noteWhitespace(params: { state: MaskState }) {
  params.state.wordBoundary = true;
}

// params.start points at the opening `/`. Returns the index after the flags,
// with the literal body blanked. Unterminated literals are treated as division.
function maskRegexLiteral(params: { chars: string[]; start: number }): number {
  const { chars, start } = params;
  let i = start + 1;
  let inClass = false;
  while (i < chars.length) {
    const character = chars[i];
    if (character === "\\") {
      i += 2;
      continue;
    }
    if (character === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (character === "]") {
      inClass = false;
      i += 1;
      continue;
    }
    if (character === "\n") {
      return start + 1;
    }
    if (character === "/" && !inClass) {
      let j = i + 1;
      while (j < chars.length && /[a-z]/i.test(chars[j])) {
        j += 1;
      }
      blankRange({ chars, start, end: j });
      return j;
    }
    i += 1;
  }
  return start + 1;
}

// Handles quotes, comments and regex literals at chars[params.i]; returns the
// new index, or -1 when the character is none of these.
function maskCodeToken(params: {
  chars: string[];
  source: string;
  i: number;
  state: MaskState;
}): number {
  const { chars, source, i, state } = params;
  const character = chars[i];
  const next = chars[i + 1];
  if (character === "'" || character === '"') {
    const end = skipQuotedString({ chars, start: i, quote: character });
    blankRange({ chars, start: i, end });
    noteValueToken({ state });
    return end;
  }
  if (character === "/" && next === "/") {
    const end = chars.indexOf("\n", i);
    blankRange({ chars, start: i, end: end === -1 ? chars.length : end });
    return end === -1 ? chars.length : end;
  }
  if (character === "/" && next === "*") {
    const end = source.indexOf("*/", i + 2);
    blankRange({ chars, start: i, end: end === -1 ? chars.length : end + 2 });
    return end === -1 ? chars.length : end + 2;
  }
  if (character === "/" && startsRegexLiteral(state)) {
    const end = maskRegexLiteral({ chars, start: i });
    noteValueToken({ state });
    return end;
  }
  return -1;
}

function skipQuotedString(params: { chars: string[]; start: number; quote: string }): number {
  const { chars, start, quote } = params;
  let j = start + 1;
  while (j < chars.length) {
    if (chars[j] === "\\") {
      j += 2;
      continue;
    }
    if (chars[j] === quote) {
      return j + 1;
    }
    j += 1;
  }
  return chars.length;
}

// params.start points at the opening backtick. Returns the index after the
// closing backtick (or end of input when unterminated), with literal text
// blanked and ${...} interpolation contents left as code.
function maskTemplateLiteral(params: {
  chars: string[];
  source: string;
  start: number;
  state: MaskState;
}): number {
  const { chars, source, start, state } = params;
  let i = start + 1;
  let literalStart = start;
  while (i < chars.length) {
    if (chars[i] === "\\") {
      i += 2;
      continue;
    }
    if (chars[i] === "`") {
      blankRange({ chars, start: literalStart, end: i });
      noteValueToken({ state });
      return i + 1;
    }
    if (chars[i] === "$" && chars[i + 1] === "{") {
      blankRange({ chars, start: literalStart, end: i });
      i = maskInterpolation({ chars, source, start: i + 2, state });
      literalStart = i;
      continue;
    }
    i += 1;
  }
  blankRange({ chars, start: literalStart, end: chars.length });
  return chars.length;
}

// params.start is just after "${". Returns the index after the matching "}".
// Each interpolation starts fresh after an opening brace, so the state from
// the surrounding code (e.g. a previous `}`) does not leak in.
function maskInterpolation(params: {
  chars: string[];
  source: string;
  start: number;
  state: MaskState;
}): number {
  const { chars, source, start, state } = params;
  state.previous = "(";
  state.word = "";
  state.wordBoundary = false;
  let depth = 1;
  let i = start;
  while (i < chars.length && depth > 0) {
    if (chars[i] === "`") {
      i = maskTemplateLiteral({ chars, source, start: i, state });
      continue;
    }
    const tokenEnd = maskCodeToken({ chars, source, i, state });
    if (tokenEnd !== -1) {
      i = tokenEnd;
      continue;
    }
    const character = chars[i];
    if (/\s/.test(character)) {
      noteWhitespace({ state });
    } else {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
      noteCodeCharacter({ character, state });
    }
    i += 1;
  }
  return i;
}

function maskNonCode(source: string): string {
  // UTF-16 units, not code points: the mask must preserve offsets into the
  // original string, and astral characters (emoji) span two units.
  const chars = source.split("");
  const state: MaskState = { previous: "", word: "", wordBoundary: false };
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "`") {
      i = maskTemplateLiteral({ chars, source, start: i, state });
      continue;
    }
    const tokenEnd = maskCodeToken({ chars, source, i, state });
    if (tokenEnd !== -1) {
      i = tokenEnd;
      continue;
    }
    if (/\s/.test(chars[i])) {
      noteWhitespace({ state });
    } else {
      noteCodeCharacter({ character: chars[i], state });
    }
    i += 1;
  }
  return chars.join("");
}

function extractAccessorChain(params: { masked: string; from: number }): {
  label: string;
  argumentFrom: number;
} | undefined {
  const { masked, from } = params;
  const segments: string[] = [];
  const accessor = /\s*(?:\.\s*([\w$]+)|\[\s*(["'`])([\s\S]*?)\2\s*\])/y;
  let index = from;
  for (;;) {
    accessor.lastIndex = index;
    const match = accessor.exec(masked);
    if (!match) {
      break;
    }
    const segment = (match[1] ?? match[3])?.trim();
    if (!segment) {
      return undefined;
    }
    segments.push(segment);
    index = accessor.lastIndex;
  }
  if (segments.length === 0 || !/^\s*\(/.test(masked.slice(index))) {
    return undefined;
  }
  return { label: segments.join("."), argumentFrom: index };
}

// Argument keys worth surfacing on the row, in priority order. The first
// matching string value answers "what did this call actually target".
const SUMMARY_KEYS = [
  "query",
  "url",
  "name",
  "identifier",
  "title",
  "path",
  "file",
  "filepath",
  "command",
  "prompt",
  "description",
  "q",
  "id",
];

const SUMMARY_MAX_LENGTH = 80;

function truncateSummary(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= SUMMARY_MAX_LENGTH) {
    return flat;
  }
  return `${flat.slice(0, SUMMARY_MAX_LENGTH - 3).trimEnd()}...`;
}

// Extracts the first top-level argument range of the call whose opening paren
// sits at `openParenIndex`. Scans the original code, skipping string and
// template literal contents so parens or commas inside strings cannot break
// the balance scan.
function extractFirstArgumentRange(
  code: string,
  openParenIndex: number,
): { start: number; end: number } | undefined {
  let index = openParenIndex;
  while (index < code.length && /\s/.test(code[index])) {
    index += 1;
  }
  if (code[index] !== "(") {
    return undefined;
  }
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = index + 1; i < code.length; i += 1) {
    const character = code[i];
    if (character === '"' || character === "'" || character === "`") {
      // A string literal can be the argument itself: it counts as the start.
      if (start === -1) {
        start = i;
      }
      i = skipStringLiteral(code, i) - 1;
      continue;
    }
    if (start === -1) {
      if (character === ")") {
        return undefined;
      }
      if (/\s/.test(character)) {
        continue;
      }
      start = i;
    }
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "}" || character === "]") {
      if (depth === 0) {
        if (character === ")") {
          end = i;
          break;
        }
        return undefined;
      }
      depth -= 1;
    } else if (depth === 0 && character === ",") {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    return undefined;
  }
  return { start, end };
}

// params.start points at the opening quote. Returns the index just after the
// closing quote (or end of input when unterminated). Template literal
// `${...}` interpolations are skipped with brace balancing.
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const character = text[i];
    if (character === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && character === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
          i = skipStringLiteral(text, i);
          continue;
        }
        if (text[i] === "{") {
          depth += 1;
        } else if (text[i] === "}") {
          depth -= 1;
        }
        i += 1;
      }
      continue;
    }
    if (character === quote) {
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function stringLiteralContent(value: string): string | undefined {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (
    (quote === '"' || quote === "'" || quote === "`") &&
    trimmed.length >= 2 &&
    trimmed[trimmed.length - 1] === quote
  ) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

// Splits on top-level separators only: string and template literal contents
// (and nested brackets) are skipped, so commas inside strings cannot split.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const character = text[i];
    if (character === '"' || character === "'" || character === "`") {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
    } else if (depth === 0 && character === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

// Picks a short, human-readable summary from the first argument's source text:
// a bare string literal is used directly; an object literal contributes the
// first matching summary key's string value (or the first string value at all);
// anything else is shown as-is, truncated.
function summarizeArgumentText(argument: string): string | undefined {
  const trimmed = argument.trim();
  const bareLiteral = stringLiteralContent(trimmed);
  if (bareLiteral !== undefined) {
    return bareLiteral.trim() ? truncateSummary(bareLiteral) : undefined;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const body = trimmed.slice(1, -1);
    let firstString: string | undefined;
    for (const entry of splitTopLevel(body, ",")) {
      const pair = entry.match(/^\s*([\w$]+)\s*:\s*([\s\S]+)$/);
      if (!pair) {
        continue;
      }
      const key = pair[1].toLowerCase();
      const value = stringLiteralContent(pair[2]);
      if (value === undefined || !value.trim()) {
        continue;
      }
      if (SUMMARY_KEYS.includes(key)) {
        return truncateSummary(value);
      }
      firstString ??= value;
    }
    return firstString ? truncateSummary(firstString) : undefined;
  }

  return truncateSummary(trimmed);
}

// Short summary for a tool input object without any code to parse (direct MCP
// tool calls): the first matching summary key's string value, else the first
// string value at all.
function summarizeToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const entries = Object.entries(input);
  let firstString: string | undefined;
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    if (SUMMARY_KEYS.includes(key.toLowerCase())) {
      return truncateSummary(value);
    }
    firstString ??= value;
  }
  return firstString ? truncateSummary(firstString) : undefined;
}

function extractCodeModeCall(code: string): { label: string; summary?: string } | undefined {
  // Offsets are preserved by the same-length mask, so candidates are found in
  // the masked text (comments and string literals blanked) while the accessor
  // chain and its argument are parsed from the original code — bracket
  // accessors like `tools["charlotte"]` keep their string content.
  const masked = maskNonCode(code);
  const word = /\btools\b/g;
  for (let match = word.exec(masked); match !== null; match = word.exec(masked)) {
    const chain = extractAccessorChain({
      masked: code,
      from: match.index + match[0].length,
    });
    if (chain) {
      const range = extractFirstArgumentRange(code, chain.argumentFrom);
      let summary: string | undefined;
      if (range) {
        const argument = code.slice(range.start, range.end).trim();
        if (argument) {
          summary = summarizeArgumentText(argument);
        }
      }
      return {
        label: chain.label,
        ...(summary ? { summary } : {}),
      };
    }
  }
  return undefined;
}

function normalizeSubAgentText(value: unknown): string | undefined {
  return nonEmptyString(value)?.trim().replace(/\s+/g, " ");
}

function readOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value.trim());
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const directText =
    readOutputText(value.output) ??
    readOutputText(value.text) ??
    readOutputText(value.content) ??
    readOutputText(value.result);
  if (directText) {
    return directText;
  }

  return undefined;
}

function parseApplyPatchDirective(
  line: string,
): { kind: "add" | "update" | "delete"; path: string } | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("*** Add File:")) {
    return { kind: "add", path: trimmed.replace("*** Add File:", "").trim() };
  }
  if (trimmed.startsWith("*** Update File:")) {
    return { kind: "update", path: trimmed.replace("*** Update File:", "").trim() };
  }
  if (trimmed.startsWith("*** Delete File:")) {
    return { kind: "delete", path: trimmed.replace("*** Delete File:", "").trim() };
  }
  return null;
}

function extractApplyPatchPrimaryFilePath(patchText: string): string | undefined {
  for (const line of patchText.split(/\r?\n/)) {
    const directive = parseApplyPatchDirective(line);
    if (directive?.path) {
      return directive.path;
    }
  }
  return undefined;
}

function normalizeDiffHeaderPath(rawPath: string): string {
  return rawPath.trim().replace(/^["']+|["']+$/g, "");
}

function applyPatchToUnifiedDiff(patchText: string): string {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sawDiffContent = false;

  for (const line of lines) {
    const directive = parseApplyPatchDirective(line);
    if (directive) {
      const filePath = normalizeDiffHeaderPath(directive.path);
      if (filePath.length > 0) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        const left = directive.kind === "add" ? "/dev/null" : `a/${filePath}`;
        const right = directive.kind === "delete" ? "/dev/null" : `b/${filePath}`;
        output.push(`diff --git a/${filePath} b/${filePath}`);
        output.push(`--- ${left}`);
        output.push(`+++ ${right}`);
        sawDiffContent = true;
      }
      continue;
    }

    const trimmed = line.trim();
    if (
      trimmed === "*** Begin Patch" ||
      trimmed === "*** End Patch" ||
      trimmed === "*** End of File" ||
      trimmed.startsWith("*** Move to:")
    ) {
      continue;
    }

    if (
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      output.push(line);
      sawDiffContent = true;
    }
  }

  if (!sawDiffContent) {
    return patchText;
  }

  const normalized = output.join("\n").trim();
  return normalized.length > 0 ? normalized : patchText;
}

const OpencodeApplyPatchTextInputSchema = z
  .object({ patchText: z.string() })
  .passthrough()
  .transform((value) => {
    const filePath = extractApplyPatchPrimaryFilePath(value.patchText);
    return {
      filePath: filePath ?? "",
      oldString: undefined,
      newString: undefined,
      unifiedDiff: truncateDiffText(applyPatchToUnifiedDiff(value.patchText)),
    };
  });

const OpencodeGrepOutputSchema = z
  .union([
    ToolGrepOutputSchema,
    z.string().transform((output) => ({ numFiles: 0, filenames: [], content: output })),
  ])
  .nullable();

function extractOpenCodeTaskSessionId(value: unknown): string | undefined {
  const text = readOutputText(value);
  if (text) {
    const match = text.match(/\btask_id:\s*(ses_[A-Za-z0-9]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  if (!isRecord(value)) {
    return undefined;
  }

  return (
    normalizeSubAgentText(value.task_id) ??
    normalizeSubAgentText(value.taskId) ??
    normalizeSubAgentText(value.sessionID) ??
    normalizeSubAgentText(value.sessionId) ??
    extractOpenCodeTaskSessionId(value.output) ??
    extractOpenCodeTaskSessionId(value.text) ??
    extractOpenCodeTaskSessionId(value.content) ??
    extractOpenCodeTaskSessionId(value.result)
  );
}

function deriveOpencodeTaskDetail(
  input: unknown,
  output: unknown,
  metadata: Record<string, unknown> | undefined,
): ToolCallDetail | null {
  if (!isRecord(input)) {
    return null;
  }

  const subAgentType = normalizeSubAgentText(input.subagent_type ?? input.subAgentType);
  const description = normalizeSubAgentText(input.description);
  if (!subAgentType && !description) {
    return null;
  }

  const childSessionId =
    normalizeSubAgentText(metadata?.sessionId) ?? extractOpenCodeTaskSessionId(output);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description ? { description } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    // COMPAT(subagent-log): remove after 2027-04-30.
    log: "",
    actions: [],
  };
}

function toOpencodeEditInput(value: { filePath: string; oldString?: string; newString?: string }) {
  return {
    filePath: value.filePath,
    oldString: nonEmptyString(value.oldString),
    newString: nonEmptyString(value.newString),
    unifiedDiff: undefined,
  };
}

const OpencodeEditInputSchema = z.union([
  z
    .object({
      filePath: z.string(),
      oldString: z.string().optional(),
      newString: z.string().optional(),
    })
    .passthrough()
    .transform(toOpencodeEditInput),
  // OpenCode v2's edit tool names the file `path`.
  z
    .object({ path: z.string(), oldString: z.string(), newString: z.string() })
    .passthrough()
    .transform((value) => toOpencodeEditInput({ ...value, filePath: value.path })),
  ToolEditInputSchema,
]);

const OpencodeEditOutputSchema = z.union([z.string().transform(() => null), ToolEditOutputSchema]);

const OpencodeKnownToolDetailSchema = z.union([
  toolDetailBranchByToolName(
    "shell",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName(
    "bash",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName(
    "exec_command",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByToolName("read", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByToolName("read_file", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByToolName(
    "write",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName(
    "write_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName(
    "create_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByToolName(
    "edit",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName(
    "apply_patch",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName(
    "apply_patch",
    OpencodeApplyPatchTextInputSchema,
    z.unknown(),
    (input) => toEditToolDetail(input, null),
  ),
  // OpenCode v2 reports apply_patch as `patch`.
  toolDetailBranchByToolName("patch", OpencodeApplyPatchTextInputSchema, z.unknown(), (input) =>
    toEditToolDetail(input, null),
  ),
  toolDetailBranchByToolName(
    "apply_diff",
    OpencodeEditInputSchema,
    OpencodeEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByToolName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByToolName(
    "grep",
    ToolSearchInputSchema,
    OpencodeGrepOutputSchema,
    (input, output) => toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByToolName("glob", ToolSearchInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolGlobOutputSchema.safeParse(output);
    return toSearchToolDetail({
      input,
      output: parsedOutput.success ? parsedOutput.data : null,
      toolName: "glob",
    });
  }),
  toolDetailBranchByToolName("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "web_search" }),
  ),
  toolDetailBranchByToolName(
    "skill",
    z.object({ name: z.string() }).passthrough(),
    z
      .union([
        z
          .object({ output: z.string() })
          .passthrough()
          .transform((value) => value.output),
        z.string(),
      ])
      .nullable(),
    (input, output) => {
      const skillName = input?.name.trim();
      if (!skillName) {
        return undefined;
      }
      return {
        type: "plain_text" as const,
        label: skillName,
        icon: "sparkles" as const,
        ...(output ? { text: output } : {}),
      } satisfies ToolCallDetail;
    },
  ),
]);

export function deriveOpencodeToolDetail(
  toolName: string,
  input: unknown,
  output: unknown,
  metadata?: Record<string, unknown>,
): ToolCallDetail {
  if (toolName.trim().toLowerCase() === "task") {
    const taskDetail = deriveOpencodeTaskDetail(input, output, metadata);
    if (taskDetail) {
      return taskDetail;
    }
  }

  if (toolName.trim().toLowerCase() === "execute" && isRecord(input)) {
    const code = input.code;
    const call = typeof code === "string" ? extractCodeModeCall(code) : undefined;
    if (call) {
      // Keep the executed code alongside the output: the previous `unknown`
      // detail exposed input and output, so the detail sheet must not lose
      // the arguments the agent sent.
      const outputText = readOutputText(output);
      const text = [typeof code === "string" ? code : undefined, outputText]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      return {
        type: "plain_text",
        label: call.label,
        title: call.label,
        ...(call.summary ? { summary: call.summary } : {}),
        icon: "wrench",
        ...(text ? { text } : {}),
      } satisfies ToolCallDetail;
    }
  }

  const detail = parseKnownToolDetail(OpencodeKnownToolDetailSchema, {
    toolName,
    input: input ?? null,
    output,
  });
  if (detail) {
    return detail;
  }
  // Tools with no dedicated detail branch (MCP tools such as webfetch or
  // websearch) still deserve more than a bare tool name: promote to a titled
  // plain_text row whose summary carries the call's key argument. The JSON
  // input stays available in the detail sheet when it is small. Execute calls
  // without a recognizable tool chain stay unknown: summarizing raw code is
  // noise, not information.
  const fallbackName = toolName.trim();
  const fallbackSummary =
    fallbackName.toLowerCase() === "execute" ? undefined : summarizeToolInput(input);
  if (fallbackName && fallbackSummary) {
    let fallbackText: string | undefined;
    try {
      const serialized = JSON.stringify(input, null, 2);
      if (serialized && serialized.length <= 2000) {
        fallbackText = serialized;
      }
    } catch {
      fallbackText = undefined;
    }
    return {
      type: "plain_text",
      label: fallbackName,
      title: fallbackName,
      summary: fallbackSummary,
      icon: "wrench",
      ...(fallbackText ? { text: fallbackText } : {}),
    } satisfies ToolCallDetail;
  }
  return {
    type: "unknown",
    input: input ?? null,
    output: output ?? null,
  };
}
