import type { ClaudeReplayEntry, ClaudeReplayParentFacts } from "./replay-source.js";
import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import { readTaskNotificationFromHistoryRecord } from "../task-notification-tool-call.js";
import { mapTaskStatus } from "./task-status.js";

/** Collect ownership while indexing; retain facts, never transcript payloads. */
export class ClaudeReplayFacts {
  private readonly toolCalls = new Map<string, { title?: string; description?: string }>();
  private readonly linksByAgentId = new Map<string, { toolCallId: string }>();
  private readonly outcomes = new Map<string, { status: ProviderSubagentStatus }>();

  observe(entry: ClaudeReplayEntry): void {
    const notification = readTaskNotificationFromHistoryRecord(entry);
    const status = mapTaskStatus(notification?.status ?? undefined);
    if (notification?.toolUseId && status) {
      this.outcomes.set(notification.toolUseId, { status });
    }
    const content = toObjectRecord(entry.message)?.content;
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const block = toObjectRecord(value);
      const declaration = readTaskDeclaration(entry.type, block);
      if (declaration) this.toolCalls.set(declaration.id, declaration.identity);
      if (
        entry.type !== "user" ||
        block?.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      )
        continue;
      if (toObjectRecord(entry.toolUseResult)?.status !== "async_launched") {
        this.outcomes.set(block.tool_use_id, {
          status: block.is_error === true ? "failed" : "completed",
        });
      }
      // Legacy transcripts predate the meta sidecar's toolUseId.
      const agentId = /agentId:\s*([\w-]+)/.exec(JSON.stringify(block.content))?.[1];
      if (agentId) this.linksByAgentId.set(agentId, { toolCallId: block.tool_use_id });
    }
  }

  snapshot(): ClaudeReplayParentFacts {
    return {
      toolCalls: this.toolCalls,
      linksByAgentId: this.linksByAgentId,
      outcomesByToolCallId: new Map([...this.outcomes].filter(([id]) => this.toolCalls.has(id))),
    };
  }
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readTaskDeclaration(
  entryType: unknown,
  block: Record<string, unknown> | undefined,
): { id: string; identity: { title?: string; description?: string } } | null {
  if (
    entryType !== "assistant" ||
    block?.type !== "tool_use" ||
    (block.name !== "Task" && block.name !== "Agent") ||
    typeof block.id !== "string"
  )
    return null;
  const input = toObjectRecord(block.input);
  const title = readNonEmptyString(input?.name) ?? readNonEmptyString(input?.subagent_type);
  const description = readNonEmptyString(input?.description);
  return {
    id: block.id,
    identity: { ...(title ? { title } : {}), ...(description ? { description } : {}) },
  };
}
