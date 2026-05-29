export type NormalizedToolCallStatus = "running" | "completed" | "failed" | "canceled";

const FAILED_STATUS_VOCAB = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "rejected",
  "denied",
]);
const CANCELED_STATUS_VOCAB = new Set(["canceled", "cancelled", "interrupted", "aborted"]);
const COMPLETED_STATUS_VOCAB = new Set(["completed", "complete", "done", "success", "succeeded"]);

export function normalizeToolCallStatus(
  rawStatus: string | undefined | null,
  error: unknown,
  output: unknown,
): NormalizedToolCallStatus {
  if (error !== undefined && error !== null) {
    return "failed";
  }

  if (typeof rawStatus === "string") {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized.length > 0) {
      if (FAILED_STATUS_VOCAB.has(normalized)) {
        return "failed";
      }
      if (CANCELED_STATUS_VOCAB.has(normalized)) {
        return "canceled";
      }
      if (COMPLETED_STATUS_VOCAB.has(normalized)) {
        return "completed";
      }
      return "running";
    }
  }

  return output !== null && output !== undefined ? "completed" : "running";
}

interface ReadChunkLike {
  text?: string;
  content?: string;
  output?: string;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const CODEX_SHELL_ENVELOPE_HEADER_LINES = new Set([
  "chunk id:",
  "wall time:",
  "process exited with code",
  "original token count:",
]);

function isCodexShellEnvelopeHeaderLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  for (const prefix of CODEX_SHELL_ENVELOPE_HEADER_LINES) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function looksLikeCodexShellEnvelope(lines: string[]): boolean {
  if (lines.length === 0) {
    return false;
  }
  const first = lines[0]?.trim().toLowerCase() ?? "";
  if (!first.startsWith("chunk id:")) {
    return false;
  }

  const headerWindow = lines.slice(0, 8).map((line) => line.trim().toLowerCase());
  const hasWallTime = headerWindow.some((line) => line.startsWith("wall time:"));
  const hasExitCode = headerWindow.some((line) => line.startsWith("process exited with code"));
  return hasWallTime && hasExitCode;
}

export function extractCodexShellOutput(value: string | undefined): string | undefined {
  const text = nonEmptyString(value);
  if (!text) {
    return undefined;
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (!looksLikeCodexShellEnvelope(lines)) {
    return text;
  }

  const outputLineIndex = lines.findIndex((line) => line.trim() === "Output:");
  if (outputLineIndex >= 0) {
    return nonEmptyString(lines.slice(outputLineIndex + 1).join("\n"));
  }

  let firstBodyLineIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isCodexShellEnvelopeHeaderLine(line)) {
      firstBodyLineIndex = index;
      break;
    }
  }

  if (firstBodyLineIndex === -1) {
    return undefined;
  }
  return nonEmptyString(lines.slice(firstBodyLineIndex).join("\n"));
}

export function extractCodexTerminalSessionId(value: string | undefined): string | undefined {
  const text = nonEmptyString(value);
  if (!text) {
    return undefined;
  }

  const match = text.match(/process running with session id\s+([A-Za-z0-9._:-]+)/i);
  return nonEmptyString(match?.[1]);
}

export function flattenReadContent<Chunk extends ReadChunkLike>(
  value: string | Chunk | Chunk[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map(
        (chunk) =>
          nonEmptyString(chunk.text) ??
          nonEmptyString(chunk.content) ??
          nonEmptyString(chunk.output),
      )
      .filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return (
    nonEmptyString(value.text) ?? nonEmptyString(value.content) ?? nonEmptyString(value.output)
  );
}

export interface StrippedReadContent {
  content: string;
  startLine?: number;
}

// Claude's Read tool returns `cat -n`-style content: each line prefixed with a
// right-aligned line number and a tab (`␣␣␣1\timport ...`). Other providers
// return raw source. We strip the gutter here so `read.content` is uniformly
// raw source across providers, and surface the first line number as `offset`
// so the client can rebuild the gutter itself. Guarded tightly (first line must
// match, near-total match ratio, strictly sequential numbering) so real source
// is never mistaken for a gutter.
const READ_GUTTER_LINE = /^\s*(\d+)\t(.*)$/;

export function stripReadLineNumberGutter(
  content: string | undefined,
): StrippedReadContent | undefined {
  const text = nonEmptyString(content);
  if (!text) {
    return undefined;
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const stripped: string[] = [];
  let nonEmpty = 0;
  let matched = 0;
  let startLine: number | undefined;
  let prevNumber: number | undefined;
  let sequential = true;
  let firstNonEmptyMatched = false;
  let sawNonEmpty = false;

  for (const line of lines) {
    if (line.length === 0) {
      stripped.push(line);
      continue;
    }
    nonEmpty += 1;
    const match = line.match(READ_GUTTER_LINE);
    if (!match) {
      if (!sawNonEmpty) {
        return undefined;
      }
      stripped.push(line);
      sawNonEmpty = true;
      continue;
    }
    if (!sawNonEmpty) {
      firstNonEmptyMatched = true;
    }
    sawNonEmpty = true;
    matched += 1;
    const lineNumber = Number.parseInt(match[1], 10);
    if (startLine === undefined) {
      startLine = lineNumber;
    }
    if (prevNumber !== undefined && lineNumber !== prevNumber + 1) {
      sequential = false;
    }
    prevNumber = lineNumber;
    stripped.push(match[2]);
  }

  if (!firstNonEmptyMatched || !sequential || nonEmpty === 0) {
    return undefined;
  }
  // Sequential numbering from the first line is already a strong signal; the
  // ratio only rejects source that has a couple of coincidental matches.
  if (matched / nonEmpty < 0.5) {
    return undefined;
  }

  return { content: stripped.join("\n"), startLine };
}

export function truncateDiffText(
  text: string | undefined,
  maxChars: number = 12_000,
): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  if (text.length <= maxChars) {
    return text;
  }

  const truncatedCount = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${truncatedCount} chars]`;
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function coerceToolCallId(params: {
  providerPrefix: string;
  rawCallId: string | null | undefined;
  toolName: string;
  input: unknown;
}): string {
  if (typeof params.rawCallId === "string" && params.rawCallId.trim().length > 0) {
    return params.rawCallId;
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(params.input) ?? "";
  } catch {
    serialized = String(params.input);
  }

  return `${params.providerPrefix}-${hashText(`${params.toolName}:${serialized}`)}`;
}
