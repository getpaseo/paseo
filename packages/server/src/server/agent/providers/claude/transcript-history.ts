import fs from "node:fs";
import path from "node:path";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";
import {
  parseClaudeSubagentMeta,
  type ClaudeReplayEntry,
  type ClaudeSubagentMeta,
} from "./subagents/replay-source.js";
import {
  parseClaudeWorkflowRun,
  type ClaudeWorkflowRun,
} from "./subagents/workflow-replay-source.js";

interface TranscriptEntry extends ClaudeReplayEntry {
  isSidechain?: unknown;
}

interface RecordLocation {
  file: string;
  offset: number;
  length: number;
  timestamp: string | null;
}

/** Chunk in bytes so UTF-8 and multi-chunk records are decoded once, at a line boundary. */
function* locatedRecords(
  file: string,
  fd: number,
): Generator<{ entry: TranscriptEntry; location: RecordLocation }> {
  const stat = fs.fstatSync(fd);
  // Opening a directory succeeds on some platforms; it must never look like empty history.
  if (stat.isDirectory()) {
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${file}'`), {
      code: "EISDIR",
      syscall: "read",
      path: file,
    });
  }
  let remaining = stat.size;
  let offset = 0;
  let pieces: Buffer[] = [];
  let length = 0;
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    remaining -= count;
    let start = 0;
    let end: number;
    while ((end = buffer.indexOf(10, start)) !== -1 && end < count) {
      pieces.push(buffer.subarray(start, end));
      length += end - start;
      const entry = parseRecord(Buffer.concat(pieces, length).toString("utf8"));
      const location = {
        file,
        offset,
        length,
        timestamp: normalizeProviderReplayTimestamp(entry?.timestamp),
      };
      offset += length + 1;
      pieces = [];
      length = 0;
      if (entry) yield { entry, location };
      start = end + 1;
    }
    if (start < count) {
      pieces.push(buffer.subarray(start, count));
      length += count - start;
    }
  }
  const entry = parseRecord(Buffer.concat(pieces, length).toString("utf8"));
  if (entry)
    yield {
      entry,
      location: {
        file,
        offset,
        length,
        timestamp: normalizeProviderReplayTimestamp(entry.timestamp),
      },
    };
}

/** Indexed sources parse only their own records using descriptors owned by this replay. */
function indexedRecords(
  locations: readonly RecordLocation[],
  descriptors: ReadonlyMap<string, number>,
): Iterable<TranscriptEntry> {
  return {
    *[Symbol.iterator]() {
      for (const location of locations) {
        const fd = descriptors.get(location.file)!;
        const buffer = Buffer.allocUnsafe(location.length);
        let read = 0;
        while (read < buffer.length) {
          const count = fs.readSync(fd, buffer, read, buffer.length - read, location.offset + read);
          if (count === 0)
            throw new Error(`Claude transcript was truncated during replay: ${location.file}`);
          read += count;
        }
        const entry = parseRecord(buffer.toString("utf8"));
        if (entry) yield entry;
      }
    },
  };
}

function isToolResult(entry: TranscriptEntry): boolean {
  return (
    Array.isArray(entry.message?.content) &&
    entry.message.content.some((block) => block?.type === "tool_result")
  );
}

function parseRecord(line: string): TranscriptEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as TranscriptEntry)
      : null;
  } catch {
    return null;
  }
}

function readOptionalFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Discover sources without retaining transcript contents. Unrelated sidechains stay excluded
 * by the replay ownership resolver; workflow children retain their separate run ownership. */
export interface ClaudeReplayHistory {
  parentEntries: Iterable<TranscriptEntry>;
  subagents: {
    agentId: string;
    meta: ClaudeSubagentMeta | null;
    entries: Iterable<TranscriptEntry>;
  }[];
  workflows: ClaudeWorkflowRun[];
  workflowEntriesByRunId: Map<string, Iterable<TranscriptEntry>>;
}

/** Own descriptors through every pass so unlink or rename cannot invalidate discovered history.
 * Sources must be consumed before the callback returns. No transcript copies are needed. */
export function withClaudeReplayHistory<T>(
  historyPath: string,
  consume: (history: ClaudeReplayHistory) => T,
): T {
  const descriptors = new Map<string, number>();
  try {
    return consume(indexHistory(historyPath, descriptors));
  } finally {
    for (const fd of descriptors.values()) fs.closeSync(fd);
  }
}

function indexHistory(historyPath: string, descriptors: Map<string, number>): ClaudeReplayHistory {
  const sessionDirectory = path.join(
    path.dirname(historyPath),
    path.basename(historyPath, ".jsonl"),
  );
  const sidechainDirectory = path.join(sessionDirectory, "subagents");
  const sidechainFiles = [historyPath];
  const workflowFiles = new Map<string, string[]>();
  const metaByAgentId = new Map<string, ClaudeSubagentMeta>();
  const directories = [sidechainDirectory];
  while (directories.length) {
    const directory = directories.pop()!;
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const parts = path.relative(sidechainDirectory, file).split(path.sep);
        if (parts[0] === "workflows" && parts.length >= 3) {
          const runId = parts[1]!;
          const files = workflowFiles.get(runId) ?? [];
          files.push(file);
          workflowFiles.set(runId, files);
        } else sidechainFiles.push(file);
        continue;
      }
      const agentId = /^agent-(.+)\.meta\.json$/.exec(entry.name)?.[1];
      if (!agentId) continue;
      const contents = readOptionalFile(file);
      const meta = contents === null ? null : parseClaudeSubagentMeta(contents);
      if (meta) metaByAgentId.set(agentId, meta);
    }
  }
  const parentLocations: RecordLocation[] = [];
  const locationsByAgentId = new Map<string, RecordLocation[]>();
  function scan(
    file: string,
    visit: (entry: TranscriptEntry, location: RecordLocation) => void,
  ): void {
    const fd = fs.openSync(file, "r");
    descriptors.set(file, fd);
    for (const { entry, location } of locatedRecords(file, fd)) visit(entry, location);
  }
  for (const file of sidechainFiles) {
    scan(file, (entry, location) => {
      if (file === historyPath && entry.isSidechain !== true) parentLocations.push(location);
      if (entry.isSidechain !== true || typeof entry.agentId !== "string") return;
      const locations = locationsByAgentId.get(entry.agentId) ?? [];
      locations.push(location);
      locationsByAgentId.set(entry.agentId, locations);
    });
  }
  const workflowEntriesByRunId = new Map<string, Iterable<TranscriptEntry>>();
  for (const [runId, files] of workflowFiles) {
    const locations: RecordLocation[] = [];
    for (const file of files)
      scan(file, (entry, location) => {
        if (entry.type !== "user" || isToolResult(entry)) locations.push(location);
      });
    locations.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return Date.parse(a.timestamp) - Date.parse(b.timestamp);
    });
    workflowEntriesByRunId.set(runId, indexedRecords(locations, descriptors));
  }
  return {
    parentEntries: indexedRecords(parentLocations, descriptors),
    subagents: [...locationsByAgentId].map(([agentId, locations]) => ({
      agentId,
      meta: metaByAgentId.get(agentId) ?? null,
      entries: indexedRecords(locations, descriptors),
    })),
    workflows: readWorkflows(sessionDirectory),
    workflowEntriesByRunId,
  };
}

function readWorkflows(sessionDirectory: string): ClaudeWorkflowRun[] {
  const workflows: ClaudeWorkflowRun[] = [];
  const workflowDirectory = path.join(sessionDirectory, "workflows");
  if (fs.existsSync(workflowDirectory)) {
    for (const entry of fs.readdirSync(workflowDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const contents = readOptionalFile(path.join(workflowDirectory, entry.name));
      const workflow = contents === null ? null : parseClaudeWorkflowRun(contents);
      if (workflow) workflows.push(workflow);
    }
  }
  return workflows;
}
