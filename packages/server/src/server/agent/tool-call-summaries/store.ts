import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  TOOL_CALL_SUMMARY_KEY,
  TOOL_CALL_INPUT_SUMMARY_KEY,
  ToolCallSummarySchema,
  type ToolCallSummaryPhase,
} from "@getpaseo/protocol/tool-call-summary";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const EntriesSchema = z.record(z.string(), ToolCallSummarySchema);
type Entries = z.infer<typeof EntriesSchema>;

function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    }) ?? "null"
  );
}

export function toolCallSummaryKey(
  item: ToolCallTimelineItem,
  phase: ToolCallSummaryPhase = "output",
): string {
  // Provider history can omit Paseo's synthesized turn IDs. The provider call ID
  // plus the complete terminal payload must agree before a saved label is reused.
  let input: unknown = item.detail;
  if (item.detail.type === "shell") input = { command: item.detail.command, cwd: item.detail.cwd };
  else if (item.detail.type === "unknown") input = item.detail.input;
  else if (item.detail.type === "plain_text") input = { label: item.detail.label };
  const payload = stableJson(
    phase === "input"
      ? ["input", item.callId, item.name, input]
      : [item.callId, item.name, item.status, item.detail, item.error],
  );
  return createHash("sha256").update(payload).digest("hex");
}

export class ToolCallSummaryStore {
  private readonly entries = new Map<string, Entries>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  private filename(agentId: string): string {
    return path.join(this.directory, `${encodeURIComponent(agentId)}.json`);
  }

  async load(agentId: string): Promise<void> {
    if (this.entries.has(agentId)) return;
    const pending = this.loads.get(agentId);
    if (pending) return pending;
    const task = this.read(agentId);
    this.loads.set(agentId, task);
    try {
      await task;
    } finally {
      this.loads.delete(agentId);
    }
  }

  private async read(agentId: string): Promise<void> {
    let entries: Entries = {};
    try {
      const text = await fs.readFile(this.filename(agentId), "utf8");
      entries = EntriesSchema.parse(JSON.parse(text));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.logger.warn({ agentId, err: error }, "Could not read tool-call summaries");
      }
    }
    this.entries.set(agentId, entries);
  }

  enrich(agentId: string, item: AgentTimelineItem): AgentTimelineItem {
    if (item.type !== "tool_call") return item;
    const summary =
      item.status === "running" ? null : this.entries.get(agentId)?.[toolCallSummaryKey(item)];
    // Tool lifecycle projection merges metadata. An explicit null clears an older
    // description when the provider subsequently changes the terminal payload.
    return {
      ...item,
      metadata: {
        ...item.metadata,
        [TOOL_CALL_SUMMARY_KEY]: summary ?? null,
        [TOOL_CALL_INPUT_SUMMARY_KEY]:
          this.entries.get(agentId)?.[toolCallSummaryKey(item, "input")] ?? null,
      },
    };
  }

  recent(agentId: string): string[] {
    return Object.values(this.entries.get(agentId) ?? {})
      .slice(-5)
      .map((entry) => entry.description);
  }

  async save(agentId: string, key: string, description: string, filePath?: string): Promise<void> {
    const entry = ToolCallSummarySchema.parse({ description, filePath });
    await this.mutate(agentId, (entries) => ({ ...entries, [key]: entry }));
  }

  async retain(agentId: string, keys: Set<string>): Promise<void> {
    await this.mutate(agentId, (entries) =>
      Object.fromEntries(Object.entries(entries).filter(([key]) => keys.has(key))),
    );
  }

  async remove(agentId: string, key: string): Promise<void> {
    await this.mutate(agentId, (entries) => {
      const next = { ...entries };
      delete next[key];
      return next;
    });
  }

  private async mutate(agentId: string, update: (entries: Entries) => Entries): Promise<void> {
    await this.load(agentId);
    const task = (this.writes.get(agentId) ?? Promise.resolve()).then(async () => {
      const next = update(this.entries.get(agentId) ?? {});
      await fs.mkdir(this.directory, { recursive: true });
      await writeJsonFileAtomic(this.filename(agentId), next);
      this.entries.set(agentId, next);
      return;
    });
    this.trackWrite(agentId, task);
    await task;
  }

  private trackWrite(agentId: string, task: Promise<void>): void {
    // A failed write is reported to its caller but must not poison later writes.
    const settled = task.catch(() => undefined);
    this.writes.set(agentId, settled);
    void settled.then(() => {
      if (this.writes.get(agentId) === settled) this.writes.delete(agentId);
      return;
    });
  }

  async delete(agentId: string): Promise<void> {
    await this.load(agentId);
    const task = (this.writes.get(agentId) ?? Promise.resolve()).then(async () => {
      await fs.rm(this.filename(agentId), { force: true });
      this.entries.delete(agentId);
      return;
    });
    this.trackWrite(agentId, task);
    await task;
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }
}
