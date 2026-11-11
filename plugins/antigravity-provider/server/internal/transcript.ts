import { open, stat } from "node:fs/promises";

export interface TranscriptToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TranscriptStep {
  stepIndex: number;
  source?: string;
  type: string;
  status?: string;
  error?: string;
  createdAt?: string;
  content?: string;
  thinking?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  toolCalls: TranscriptToolCall[];
}

export interface SystemWakeupInfo {
  sender?: string;
  finishedTaskId?: string;
  failedTaskId?: string;
  message: string;
}

export class JsonlTranscriptReader {
  private byteOffset = 0;
  private fallbackStepSeq = 0;

  constructor(readonly filePath: string) {}

  reset(): void {
    this.byteOffset = 0;
    this.fallbackStepSeq = 0;
  }

  async seekToEnd(): Promise<number> {
    const steps = await this.readNewSteps({ allowTrailingWithoutNewline: true });
    let maxStep = -1;
    for (const step of steps) {
      if (step.stepIndex > maxStep) maxStep = step.stepIndex;
    }
    return maxStep;
  }

  async readNewSteps(options?: {
    allowTrailingWithoutNewline?: boolean;
  }): Promise<TranscriptStep[]> {
    let fileSize: number;
    try {
      const info = await stat(this.filePath);
      if (!info.isFile()) return [];
      fileSize = info.size;
    } catch {
      return [];
    }

    if (fileSize < this.byteOffset) {
      this.byteOffset = 0;
    }
    if (fileSize === this.byteOffset) {
      return [];
    }

    const bytesToRead = fileSize - this.byteOffset;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const handle = await open(this.filePath, "r");
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, bytesToRead, this.byteOffset);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }
    if (bytesRead <= 0) return [];

    const slice = buffer.subarray(0, bytesRead);
    const lastNewline = slice.lastIndexOf(0x0a);
    let consumable: Buffer;

    if (lastNewline === -1) {
      if (!options?.allowTrailingWithoutNewline) {
        return [];
      }
      const parsedSingle = parseStepLine(slice.toString("utf8"), () => this.fallbackStepSeq++);
      if (!parsedSingle) return [];
      this.byteOffset += bytesRead;
      return [parsedSingle];
    }

    const throughNewline = slice.subarray(0, lastNewline + 1);
    const remainder = slice.subarray(lastNewline + 1);
    consumable = throughNewline;
    let consumedBytes = lastNewline + 1;

    const steps: TranscriptStep[] = [];
    for (const line of consumable.toString("utf8").split(/\r?\n/)) {
      const step = parseStepLine(line, () => this.fallbackStepSeq++);
      if (step) steps.push(step);
    }

    if (remainder.byteLength > 0 && options?.allowTrailingWithoutNewline) {
      const trailingStep = parseStepLine(remainder.toString("utf8"), () => this.fallbackStepSeq++);
      if (trailingStep) {
        steps.push(trailingStep);
        consumedBytes = bytesRead;
      }
    }

    this.byteOffset += consumedBytes;
    return steps;
  }
}

function parseStepLine(rawLine: string, nextFallbackIndex: () => number): TranscriptStep | null {
  const obj = tryParseObjectLine(rawLine);
  if (!obj) return null;

  const type = typeof obj.type === "string" ? obj.type : "UNKNOWN";
  const stepIndex =
    typeof obj.step_index === "number" && Number.isFinite(obj.step_index)
      ? obj.step_index
      : nextFallbackIndex();

  const step: TranscriptStep = {
    stepIndex,
    type,
    toolCalls: parseTranscriptToolCalls(obj.tool_calls),
  };
  assignOptionalStepFields(step, obj);
  return step;
}

function tryParseObjectLine(rawLine: string): Record<string, unknown> | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseTranscriptToolCalls(rawCalls: unknown): TranscriptToolCall[] {
  if (!Array.isArray(rawCalls)) return [];
  const toolCalls: TranscriptToolCall[] = [];
  for (const rawCall of rawCalls) {
    if (typeof rawCall !== "object" || rawCall === null || Array.isArray(rawCall)) continue;
    const record = rawCall as Record<string, unknown>;
    const name =
      typeof record.name === "string" && record.name.trim() ? record.name.trim() : "tool";
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
    const args = normalizeTranscriptToolArgs(record.args);
    toolCalls.push({ ...(id ? { id } : {}), name, args });
  }
  return toolCalls;
}

function assignOptionalStepFields(step: TranscriptStep, obj: Record<string, unknown>): void {
  if (typeof obj.source === "string") step.source = obj.source;
  if (typeof obj.status === "string") step.status = obj.status;
  if (typeof obj.error === "string") step.error = obj.error;
  if (typeof obj.created_at === "string") step.createdAt = obj.created_at;
  if (typeof obj.content === "string") step.content = obj.content;
  if (typeof obj.thinking === "string") step.thinking = obj.thinking;
  if (typeof obj.input_tokens === "number") step.inputTokens = obj.input_tokens;
  if (typeof obj.cache_read_tokens === "number") step.cacheReadTokens = obj.cache_read_tokens;
  if (typeof obj.output_tokens === "number") step.outputTokens = obj.output_tokens;
}

const STRING_PRESERVED_ARG_KEYS = new Set([
  "id",
  "TaskId",
  "Recipient",
  "CommandId",
  "conversationId",
  "sessionId",
]);

export function normalizeTranscriptToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    result[key] = unwrapTranscriptArgValue(key, value);
  }
  return result;
}

function unwrapTranscriptArgValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  if (STRING_PRESERVED_ARG_KEYS.has(key)) {
    return value;
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return value;
}

export function cleanUserInputText(rawContent: string | undefined): string {
  if (!rawContent) return "";
  const requestMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(rawContent);
  if (requestMatch?.[1] !== undefined) {
    return requestMatch[1].trim();
  }
  return rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
}

export function parseSystemWakeupMessage(step: TranscriptStep): SystemWakeupInfo | null {
  const content = step.content ?? "";
  if (step.type !== "SYSTEM_MESSAGE" && !/<SYSTEM_MESSAGE>/i.test(content)) {
    return null;
  }
  const inner =
    /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(content)?.[1] ?? content.trim();
  const sender = /\bsender=([^\s>]+)/.exec(inner)?.[1];
  const finishedTaskId =
    /Task id "([^"]+)"\s+(?:finished|completed)/i.exec(inner)?.[1] ?? undefined;
  const failedTaskId =
    /Task id "([^"]+)"\s+(?:failed|stopped|killed|terminated|canceled|cancelled)/i.exec(
      inner,
    )?.[1] ?? undefined;
  const contentIdx = inner.indexOf("content=");
  const message = contentIdx >= 0 ? inner.slice(contentIdx + "content=".length).trim() : inner;

  return {
    ...(sender ? { sender } : {}),
    ...(finishedTaskId ? { finishedTaskId } : {}),
    ...(failedTaskId ? { failedTaskId } : {}),
    message,
  };
}

export function computeStepContextWindowTokens(step: TranscriptStep): number | undefined {
  if (
    step.inputTokens === undefined &&
    step.cacheReadTokens === undefined &&
    step.outputTokens === undefined
  ) {
    return undefined;
  }
  const total = (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.outputTokens ?? 0);
  return total > 0 ? total : undefined;
}

export function extractTranscriptToolResultOutput(step: TranscriptStep): string | undefined {
  const raw = step.content;
  if (!raw) return step.error;
  const cmdOutIdx = raw.indexOf("Command output:\n");
  if (cmdOutIdx >= 0) {
    return raw.slice(cmdOutIdx + "Command output:\n".length);
  }
  const stripped = raw.replace(/^(?:Created At: [^\n]+\n|Completed At: [^\n]+\n)+/g, "").trim();
  return stripped || step.error;
}
