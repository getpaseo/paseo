import { z } from "zod";

import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../../provider-history-timestamps.js";
import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import type { SubagentObservation } from "./observation.js";
import { buildClaudeSubagentSubtitle } from "./presentation.js";
import type { ClaudeReplayEntry } from "./replay-source.js";
import { formatClaudeWorkflowResult } from "./workflow-output.js";

const ClaudeWorkflowRunSchema = z.object({
  runId: z.string(),
  timestamp: z.string().optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  workflowName: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  startTime: z.number().optional().catch(undefined),
  defaultModel: z.string().optional().catch(undefined),
  totalTokens: z.number().optional().catch(undefined),
  result: z.unknown().optional(),
});

export type ClaudeWorkflowRun = z.infer<typeof ClaudeWorkflowRunSchema>;

export interface ClaudeWorkflowParentEntry {
  message?: { content?: unknown };
}

export function parseClaudeWorkflowRun(contents: string): ClaudeWorkflowRun | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const result = ClaudeWorkflowRunSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Rebuild workflow rows from Claude's persisted run summaries.
 *
 * The parent tool result links a Workflow tool-use id to a run id. The run summary owns the
 * terminal outcome and presentation facts. A nonterminal summary cannot still be live after the
 * provider runtime was recreated, so replay terminalizes it as failed instead of resurrecting a
 * row that can never receive another update.
 */
export function observeReplayWorkflows(input: {
  workflows: readonly ClaudeWorkflowRun[];
  parentEntries: readonly ClaudeWorkflowParentEntry[];
  entriesByRunId?: ReadonlyMap<string, readonly ClaudeReplayEntry[]>;
  convertEntry?: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
}): SubagentObservation[] {
  const toolCallIdByRunId = readWorkflowLinks(input.parentEntries);
  const observations: SubagentObservation[] = [];

  for (const workflow of input.workflows) {
    const id = toolCallIdByRunId.get(workflow.runId);
    if (!id) continue;
    const description = readString(workflow.summary) ?? readString(workflow.workflowName);
    const startedAt = normalizeEpochTimestamp(workflow.startTime);
    const finishedAt = normalizeIsoTimestamp(workflow.timestamp);

    observations.push({
      kind: "declared",
      id,
      toolCallId: id,
      title: "Workflow",
      ...(description ? { description } : {}),
      ...(startedAt ? { timestamp: startedAt } : {}),
    });
    if (description) {
      observations.push({
        kind: "timeline",
        id,
        item: { type: "user_message", text: description },
        ...(startedAt ? { timestamp: startedAt } : {}),
      });
    }

    observations.push(
      ...observeWorkflowTimeline({
        id,
        result: workflow.result,
        entries: input.entriesByRunId?.get(workflow.runId) ?? [],
        convertEntry: input.convertEntry,
        finishedAt,
      }),
    );

    const subtitle = buildClaudeSubagentSubtitle({
      title: "Workflow",
      ...(readString(workflow.defaultModel) ? { model: workflow.defaultModel } : {}),
      ...(typeof workflow.totalTokens === "number"
        ? { usage: { totalTokens: workflow.totalTokens } }
        : {}),
    });
    if (subtitle) {
      observations.push({
        kind: "subtitle",
        id,
        subtitle,
        ...(finishedAt ? { timestamp: finishedAt } : {}),
      });
    }
    observations.push({
      kind: "status",
      id,
      status: replayWorkflowStatus(workflow.status),
      ...(finishedAt ? { timestamp: finishedAt } : {}),
    });
  }

  return observations;
}

function observeWorkflowTimeline(input: {
  id: string;
  result: unknown;
  entries: readonly ClaudeReplayEntry[];
  convertEntry?: (entry: ClaudeReplayEntry) => AgentTimelineItem[];
  finishedAt?: string;
}): SubagentObservation[] {
  const observations: SubagentObservation[] = [];
  const replayedAssistantText = new Set<string>();
  const entries = [...input.entries].sort(compareReplayTimestamps);

  for (const entry of entries) {
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    const items = input.convertEntry?.(entry) ?? [];
    for (const item of items) {
      if (item.type === "assistant_message") replayedAssistantText.add(item.text.trim());
      observations.push({
        kind: "timeline",
        id: input.id,
        item,
        ...(timestamp ? { timestamp } : {}),
      });
    }
  }

  const resultText = formatClaudeWorkflowResult(input.result);
  if (!resultText || replayedAssistantText.has(resultText.trim())) return observations;
  observations.push({
    kind: "timeline",
    id: input.id,
    item: { type: "assistant_message", text: resultText },
    ...(input.finishedAt ? { timestamp: input.finishedAt } : {}),
  });
  return observations;
}

function compareReplayTimestamps(a: ClaudeReplayEntry, b: ClaudeReplayEntry): number {
  const aTimestamp = normalizeProviderReplayTimestamp(a.timestamp);
  const bTimestamp = normalizeProviderReplayTimestamp(b.timestamp);
  if (!aTimestamp && !bTimestamp) return 0;
  if (!aTimestamp) return 1;
  if (!bTimestamp) return -1;
  return Date.parse(aTimestamp) - Date.parse(bTimestamp);
}

function readWorkflowLinks(entries: readonly ClaudeWorkflowParentEntry[]): Map<string, string> {
  const workflowToolCallIds = new Set<string>();
  const toolCallIdByRunId = new Map<string, string>();

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = toRecord(value);
      if (block?.type !== "tool_use" || block.name !== "Workflow") continue;
      const id = readString(block.id);
      if (id) workflowToolCallIds.add(id);
    }
  }

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = toRecord(value);
      if (block?.type !== "tool_result") continue;
      const toolCallId = readString(block.tool_use_id);
      if (!toolCallId || !workflowToolCallIds.has(toolCallId)) continue;
      const runId = readRunId(block.content);
      if (runId) toolCallIdByRunId.set(runId, toolCallId);
    }
  }

  return toolCallIdByRunId;
}

function readRunId(content: unknown): string | undefined {
  const text = readResultText(content);
  if (!text) return undefined;
  return /(?:^|\n)Run ID:\s*(wf_[A-Za-z0-9-]+)/u.exec(text)?.[1];
}

function readResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((value) => {
      const block = toRecord(value);
      return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((value): value is string => value !== undefined)
    .join("\n");
  return text || undefined;
}

function replayWorkflowStatus(status: string | undefined): ProviderSubagentStatus {
  switch (status?.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return "failed";
  }
}

function normalizeEpochTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
