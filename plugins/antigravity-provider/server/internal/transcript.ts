import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

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
  private activePath: string | null = null;
  private lastIno: number | null = null;
  private checkedInitialFullSibling = false;
  private readonly preferredFullPath: string | null;

  constructor(readonly filePath: string) {
    this.preferredFullPath =
      path.basename(filePath) === "transcript.jsonl"
        ? path.join(path.dirname(filePath), "transcript_full.jsonl")
        : null;
  }

  reset(): void {
    this.byteOffset = 0;
    this.fallbackStepSeq = 0;
    this.activePath = null;
    this.lastIno = null;
    this.checkedInitialFullSibling = false;
  }

  async seekToEnd(): Promise<number> {
    const steps = await this.readNewSteps({
      allowTrailingWithoutNewline: true,
      advancePastUnfinished: true,
    });
    let maxStep = -1;
    for (const step of steps) {
      if (step.stepIndex > maxStep) maxStep = step.stepIndex;
    }
    return maxStep;
  }

  private async resolveReadTarget(): Promise<{
    targetPath: string;
    fileSize: number;
    ino: number;
  } | null> {
    if (this.preferredFullPath) {
      const fullTarget = await tryStatRegularFile(this.preferredFullPath);
      if (fullTarget) {
        if (this.activePath !== this.preferredFullPath) {
          this.activePath = this.preferredFullPath;
          this.byteOffset = 0;
          this.lastIno = fullTarget.ino;
        }
        return {
          targetPath: this.preferredFullPath,
          fileSize: fullTarget.size,
          ino: fullTarget.ino,
        };
      }

      const compactTarget = await tryStatRegularFile(this.filePath);
      if (!compactTarget) return null;

      if (!this.checkedInitialFullSibling) {
        this.checkedInitialFullSibling = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const delayedFull = await tryStatRegularFile(this.preferredFullPath);
        if (delayedFull) {
          this.activePath = this.preferredFullPath;
          this.byteOffset = 0;
          this.lastIno = delayedFull.ino;
          return {
            targetPath: this.preferredFullPath,
            fileSize: delayedFull.size,
            ino: delayedFull.ino,
          };
        }
      }

      if (this.activePath !== this.filePath) {
        this.activePath = this.filePath;
        this.byteOffset = 0;
        this.lastIno = compactTarget.ino;
      }
      return {
        targetPath: this.filePath,
        fileSize: compactTarget.size,
        ino: compactTarget.ino,
      };
    }

    const directTarget = await tryStatRegularFile(this.filePath);
    if (!directTarget) return null;
    return {
      targetPath: this.filePath,
      fileSize: directTarget.size,
      ino: directTarget.ino,
    };
  }

  async readNewSteps(options?: {
    allowTrailingWithoutNewline?: boolean;
    advancePastUnfinished?: boolean;
  }): Promise<TranscriptStep[]> {
    const resolved = await this.resolveReadTarget();
    if (!resolved) return [];

    const { targetPath, fileSize, ino } = resolved;
    if (this.lastIno !== null && ino !== this.lastIno) {
      this.byteOffset = 0;
    }
    this.lastIno = ino;

    if (fileSize < this.byteOffset) {
      this.byteOffset = 0;
    }
    if (fileSize === this.byteOffset) {
      return [];
    }

    let slice = await this.readSliceWithBoundaryCheck(targetPath, fileSize);
    if (!slice || slice.byteLength === 0) return [];

    const allowTrailing = options?.allowTrailingWithoutNewline ?? false;
    const advanceUnfinished = options?.advancePastUnfinished ?? false;
    const parsed = this.consumeSlice(slice, allowTrailing, advanceUnfinished);
    if (parsed.corruptedAtOffset && this.byteOffset > 0) {
      this.byteOffset = 0;
      slice = await this.readSliceWithBoundaryCheck(targetPath, fileSize);
      if (!slice || slice.byteLength === 0) return [];
      return this.consumeSlice(slice, allowTrailing, advanceUnfinished).steps;
    }
    return parsed.steps;
  }

  private async readSliceWithBoundaryCheck(
    targetPath: string,
    fileSize: number,
  ): Promise<Buffer | null> {
    const handle = await open(targetPath, "r");
    try {
      if (this.byteOffset > 0) {
        const probeLength = fileSize - (this.byteOffset - 1);
        const probeBuffer = Buffer.allocUnsafe(probeLength);
        const result = await handle.read(probeBuffer, 0, probeLength, this.byteOffset - 1);
        if (result.bytesRead <= 1) return null;
        if (probeBuffer[0] === 0x0a) {
          return probeBuffer.subarray(1, result.bytesRead);
        }
        // Earlier lines were rewritten in place and shifted byte offsets; rescan from 0.
        this.byteOffset = 0;
      }

      const fullBuffer = Buffer.allocUnsafe(fileSize);
      const fullResult = await handle.read(fullBuffer, 0, fileSize, 0);
      if (fullResult.bytesRead <= 0) return null;
      return fullBuffer.subarray(0, fullResult.bytesRead);
    } finally {
      await handle.close();
    }
  }

  private consumeSlice(
    slice: Buffer,
    allowTrailingWithoutNewline: boolean,
    advancePastUnfinished: boolean,
  ): { steps: TranscriptStep[]; corruptedAtOffset: boolean } {
    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      return this.consumeSingleTrailingLine(
        slice,
        allowTrailingWithoutNewline,
        advancePastUnfinished,
      );
    }

    let cursor = 0;
    let safeConsumedBytes = 0;
    let hasTrailingUnfinished = false;
    let isFirstNonEmptyLine = true;
    const steps: TranscriptStep[] = [];

    while (cursor <= lastNewline) {
      const nlIdx = slice.indexOf(0x0a, cursor);
      if (nlIdx === -1 || nlIdx > lastNewline) break;
      const lineText = slice.subarray(cursor, nlIdx + 1).toString("utf8");
      cursor = nlIdx + 1;
      if (!lineText.trim()) {
        if (!hasTrailingUnfinished) safeConsumedBytes = cursor;
        continue;
      }
      const step = parseStepLine(lineText, () => this.fallbackStepSeq++);
      if (!step) {
        if (isFirstNonEmptyLine && this.byteOffset > 0) {
          return { steps: [], corruptedAtOffset: true };
        }
        isFirstNonEmptyLine = false;
        if (!hasTrailingUnfinished) safeConsumedBytes = cursor;
        continue;
      }
      isFirstNonEmptyLine = false;
      steps.push(step);
      hasTrailingUnfinished = !advancePastUnfinished && isUnfinishedTranscriptStep(step);
      if (!hasTrailingUnfinished) safeConsumedBytes = cursor;
    }

    safeConsumedBytes = this.consumeTrailingRemainder(
      slice,
      lastNewline,
      allowTrailingWithoutNewline,
      advancePastUnfinished,
      safeConsumedBytes,
      steps,
    );

    this.byteOffset += safeConsumedBytes;
    return { steps, corruptedAtOffset: false };
  }

  private consumeSingleTrailingLine(
    slice: Buffer,
    allowTrailingWithoutNewline: boolean,
    advancePastUnfinished: boolean,
  ): { steps: TranscriptStep[]; corruptedAtOffset: boolean } {
    if (!allowTrailingWithoutNewline) {
      return { steps: [], corruptedAtOffset: false };
    }
    const parsedSingle = parseStepLine(slice.toString("utf8"), () => this.fallbackStepSeq++);
    if (!parsedSingle) {
      return { steps: [], corruptedAtOffset: slice.toString("utf8").trim().length > 0 };
    }
    if (advancePastUnfinished || !isUnfinishedTranscriptStep(parsedSingle)) {
      this.byteOffset += slice.byteLength;
    }
    return { steps: [parsedSingle], corruptedAtOffset: false };
  }

  private consumeTrailingRemainder(
    slice: Buffer,
    lastNewline: number,
    allowTrailingWithoutNewline: boolean,
    advancePastUnfinished: boolean,
    safeConsumedBytes: number,
    steps: TranscriptStep[],
  ): number {
    const remainder = slice.subarray(lastNewline + 1);
    if (remainder.byteLength === 0 || !allowTrailingWithoutNewline) {
      return safeConsumedBytes;
    }
    const trailingStep = parseStepLine(remainder.toString("utf8"), () => this.fallbackStepSeq++);
    if (!trailingStep) {
      return safeConsumedBytes;
    }
    steps.push(trailingStep);
    const unfinished = !advancePastUnfinished && isUnfinishedTranscriptStep(trailingStep);
    return unfinished ? safeConsumedBytes : slice.byteLength;
  }
}

function isUnfinishedTranscriptStep(step: TranscriptStep): boolean {
  if (step.type === "PLANNER_RESPONSE" && isNonTerminalStepStatus(step.status)) {
    return true;
  }
  if (step.type === "GENERIC" && isWaitingStepStatus(step.status)) {
    return true;
  }
  return false;
}

async function tryStatRegularFile(filePath: string): Promise<{ size: number; ino: number } | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return { size: info.size, ino: info.ino };
  } catch {
    return null;
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

const CORTEX_STEP_STATUS_WAITING = 9;
const WAITING_STEP_STATUSES = new Set(["WAITING", "WAITING_FOR_USER"]);
const NON_TERMINAL_STEP_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "GENERATING",
  "WAITING",
  "WAITING_FOR_USER",
  "QUEUED",
  "ACTIVE",
]);

interface ReadOnlyDatabaseSync {
  prepare(sql: string): { get(...params: number[]): Record<string, unknown> | undefined };
  close(): void;
}

interface BuiltinSqliteModule {
  DatabaseSync: new (filePath: string, options?: { readOnly?: boolean }) => ReadOnlyDatabaseSync;
}

function getBuiltinSqlite(): BuiltinSqliteModule | null {
  const mod = process.getBuiltinModule?.("node:sqlite") as Partial<BuiltinSqliteModule> | undefined;
  return typeof mod?.DatabaseSync === "function" ? (mod as BuiltinSqliteModule) : null;
}

export function isWaitingStepStatus(status: string | undefined): boolean {
  return status !== undefined && WAITING_STEP_STATUSES.has(status.toUpperCase());
}

export function isNonTerminalStepStatus(status: string | undefined): boolean {
  return status !== undefined && NON_TERMINAL_STEP_STATUSES.has(status.toUpperCase());
}

export function isConversationStepWaitingForApproval(
  dbPath: string,
  afterStepIndex: number,
): boolean {
  if (!existsSync(dbPath)) return false;
  const sqlite = getBuiltinSqlite();
  if (!sqlite) return false;
  let db: ReadOnlyDatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT status FROM steps WHERE idx > ? AND status = ? LIMIT 1")
      .get(afterStepIndex, CORTEX_STEP_STATUS_WAITING);
    return row !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
