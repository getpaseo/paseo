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

function extractAccessorChain(params: { masked: string; from: number }): string | undefined {
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
  return segments.join(".");
}

function extractCodeModeToolLabel(code: string): string | undefined {
  // Offsets are preserved by the same-length mask, so candidates are found in
  // the masked text (comments and string literals blanked) while the accessor
  // chain itself is parsed from the original code — bracket accessors like
  // `tools["charlotte"]` keep their string content.
  const masked = maskNonCode(code);
  const word = /\btools\b/g;
  for (let match = word.exec(masked); match !== null; match = word.exec(masked)) {
    const label = extractAccessorChain({
      masked: code,
      from: match.index + match[0].length,
    });
    if (label) {
      return label;
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

function formatLogEntry(value: unknown): string | undefined {
  const outputText = readOutputText(value);
  if (outputText) {
    return outputText;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

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
  error: unknown,
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

  const log = [formatLogEntry(output), formatLogEntry(error)].filter((entry) => entry).join("\n");
  const childSessionId =
    normalizeSubAgentText(metadata?.sessionId) ?? extractOpenCodeTaskSessionId(output);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description ? { description } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    log,
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
  error: unknown = null,
  metadata?: Record<string, unknown>,
): ToolCallDetail {
  if (toolName.trim().toLowerCase() === "task") {
    const taskDetail = deriveOpencodeTaskDetail(input, output, error, metadata);
    if (taskDetail) {
      return taskDetail;
    }
  }

  if (toolName.trim().toLowerCase() === "execute" && isRecord(input)) {
    const code = input.code;
    const label = typeof code === "string" ? extractCodeModeToolLabel(code) : undefined;
    if (label) {
      // Keep the executed code alongside the output: the previous `unknown`
      // detail exposed input and output, so the detail sheet must not lose
      // the arguments the agent sent.
      const outputText = readOutputText(output);
      const text = [typeof code === "string" ? code : undefined, outputText]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      return {
        type: "plain_text",
        label,
        icon: "wrench",
        ...(text ? { text } : {}),
      } satisfies ToolCallDetail;
    }
  }

  const parsed = OpencodeKnownToolDetailSchema.safeParse({
    toolName,
    input,
    output,
  });
  if (parsed.success && parsed.data) {
    return parsed.data;
  }
  return {
    type: "unknown",
    input: input ?? null,
    output: output ?? null,
  };
}
