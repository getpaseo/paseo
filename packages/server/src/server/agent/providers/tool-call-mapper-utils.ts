type ReadChunkLike = {
  text?: string;
  content?: string;
  output?: string;
};

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function commandFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tokens = value.filter(
    (token): token is string => typeof token === "string" && token.length > 0
  );
  return tokens.length > 0 ? tokens.join(" ") : undefined;
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

export function flattenReadContent<Chunk extends ReadChunkLike>(
  value: string | Chunk | Chunk[] | undefined
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
          nonEmptyString(chunk.output)
      )
      .filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return (
    nonEmptyString(value.text) ??
    nonEmptyString(value.content) ??
    nonEmptyString(value.output)
  );
}

export function truncateDiffText(
  text: string | undefined,
  maxChars: number = 12_000
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
