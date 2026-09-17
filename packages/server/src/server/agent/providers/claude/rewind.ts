import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { forkSession as claudeForkSession, type Query } from "@anthropic-ai/claude-agent-sdk";

import { claudeProjectDirSync } from "./project-dir.js";

interface ClaudeForkOptions {
  upToMessageId: string;
  dir: string;
}

const COMPACTION_UUID_PATHS = [
  ["preservedSegment", "headUuid"],
  ["preservedSegment", "anchorUuid"],
  ["preservedSegment", "tailUuid"],
  ["preservedMessages", "anchorUuid"],
  ["preservedMessages", "uuids"],
  ["preservedMessages", "allUuids"],
] as const;

export interface ClaudeRewindSdk {
  forkSession(sessionId: string, options: ClaudeForkOptions): Promise<{ sessionId: string }>;
}

export const realClaudeRewindSdk: ClaudeRewindSdk = {
  async forkSession(sessionId, options) {
    const fork = await claudeForkSession(sessionId, options);
    // The SDK remaps entry UUIDs but leaves compaction references pointing at the source session.
    // Repair them before Paseo resumes the fork, or compacted-away history becomes active again.
    await repairForkedCompactionMetadata({ cwd: options.dir, sessionId: fork.sessionId });
    return fork;
  },
};

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  cwd: string;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    dir: input.cwd,
  });
  input.setSessionId(fork.sessionId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  cwd: string;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}

interface RepairForkedCompactionInput {
  cwd: string;
  sessionId: string;
}

async function repairForkedCompactionMetadata(input: RepairForkedCompactionInput): Promise<void> {
  const projectDir = claudeProjectDirSync(input.cwd);
  const transcriptPath = join(projectDir, `${input.sessionId}.jsonl`);
  const transcript = await readFile(transcriptPath, "utf8");
  const lines = transcript.split("\n");
  const forkedUuidMap = collectForkedUuidMap(lines, transcriptPath);
  let changed = false;
  const repairedLines = lines.map((line, index) => {
    if (line.trim().length === 0) {
      return line;
    }
    const entry = parseTranscriptEntry(line, transcriptPath, index);
    if (!repairCompactionEntry(entry, forkedUuidMap)) {
      return line;
    }
    changed = true;
    return JSON.stringify(entry);
  });
  if (!changed) {
    return;
  }

  const transcriptStat = await stat(transcriptPath);
  const mode = transcriptStat.mode & 0o777;
  const temporaryPath = join(
    dirname(transcriptPath),
    `.${input.sessionId}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, repairedLines.join("\n"), { encoding: "utf8", mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, transcriptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function collectForkedUuidMap(lines: string[], transcriptPath: string): Map<string, string> {
  const forkedUuidMap = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseTranscriptEntry(line, transcriptPath, index);
    const forkedFrom = asRecord(entry["forkedFrom"]);
    const sourceUuid = forkedFrom?.["messageUuid"];
    const forkedUuid = entry["uuid"];
    if (typeof sourceUuid === "string" && typeof forkedUuid === "string") {
      forkedUuidMap.set(sourceUuid, forkedUuid);
    }
  }
  return forkedUuidMap;
}

function parseTranscriptEntry(
  line: string,
  transcriptPath: string,
  index: number,
): Record<string, unknown> {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON in ${transcriptPath} at line ${index + 1}`, { cause: error });
  }
  const record = asRecord(entry);
  if (!record) {
    throw new Error(`Expected an object in ${transcriptPath} at line ${index + 1}`);
  }
  return record;
}

function repairCompactionEntry(
  entry: Record<string, unknown>,
  forkedUuidMap: Map<string, string>,
): boolean {
  if (entry["type"] !== "system" || entry["subtype"] !== "compact_boundary") {
    return false;
  }
  const metadata = asRecord(entry["compactMetadata"]);
  if (!metadata) {
    return false;
  }
  let changed = false;
  for (const [sectionName, fieldName] of COMPACTION_UUID_PATHS) {
    const section = asRecord(metadata[sectionName]);
    if (!section) {
      continue;
    }
    const sourceValue = section[fieldName];
    if (typeof sourceValue === "string") {
      const forkedUuid = forkedUuidMap.get(sourceValue);
      if (forkedUuid && forkedUuid !== sourceValue) {
        section[fieldName] = forkedUuid;
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(sourceValue)) {
      continue;
    }
    const forkedValue = sourceValue.map((sourceUuid) => {
      if (typeof sourceUuid !== "string") {
        return sourceUuid;
      }
      return forkedUuidMap.get(sourceUuid) ?? sourceUuid;
    });
    if (forkedValue.some((forkedUuid, index) => forkedUuid !== sourceValue[index])) {
      section[fieldName] = forkedValue;
      changed = true;
    }
  }
  return changed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
