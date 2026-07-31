import type { MaterialProgressPayload } from "../messages.js";
import type { AgentTimelineItem, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { TimelineProjectionEntry } from "./timeline-projection.js";

export interface AnalyzeMaterialProgressInput {
  entries: readonly TimelineProjectionEntry[] | null;
  turnOutcome: "completed" | "failed" | "canceled" | null;
}

type MaterialProgressKind = NonNullable<MaterialProgressPayload["lastMaterialProgressKind"]>;

function hasConcreteText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function materialToolKind(item: ToolCallTimelineItem): MaterialProgressKind | null {
  if (item.status !== "completed") return null;

  switch (item.detail.type) {
    case "edit":
      return "edit";
    case "write":
      return "write";
    case "shell":
    case "worktree_setup":
    case "sub_agent":
    case "unknown":
    case "read":
    case "search":
    case "fetch":
    case "plain_text":
    case "plan":
      return null;
  }
}

function validTimestamp(value: string): string | null {
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function orderedEntries(entries: readonly TimelineProjectionEntry[]): TimelineProjectionEntry[] {
  return [...entries].sort(
    (left, right) => left.seqEnd - right.seqEnd || left.seqStart - right.seqStart,
  );
}

function noProgress(reason: string): MaterialProgressPayload {
  return {
    state: "none",
    completedCompactionsSinceMaterialProgress: 0,
    lastMaterialProgressAt: null,
    lastMaterialProgressKind: null,
    reason,
  };
}

function materialKind(
  item: AgentTimelineItem,
  isFinalTerminalAssistant: boolean,
): MaterialProgressKind | null {
  if (item.type === "tool_call") return materialToolKind(item);
  if (item.type === "assistant_message" && isFinalTerminalAssistant && hasConcreteText(item.text)) {
    return "assistant_result";
  }
  return null;
}

export function analyzeMaterialProgress({
  entries,
  turnOutcome,
}: AnalyzeMaterialProgressInput): MaterialProgressPayload {
  if (entries === null) return noProgress("Timeline history is unavailable.");

  const ordered = orderedEntries(entries);
  let latestUserIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.item.type === "user_message") latestUserIndex = index;
  }
  if (latestUserIndex < 0) return noProgress("No current continuation is available.");

  const continuation = ordered.slice(latestUserIndex + 1);
  let finalAssistantIndex = -1;
  if (turnOutcome === "completed") {
    for (let index = 0; index < continuation.length; index += 1) {
      if (continuation[index]?.item.type === "assistant_message") finalAssistantIndex = index;
    }
  }

  let completedCompactions = 0;
  let lastMaterialProgressAt: string | null = null;
  let lastMaterialProgressKind: MaterialProgressKind | null = null;

  for (let index = 0; index < continuation.length; index += 1) {
    const entry = continuation[index];
    if (!entry) continue;
    const kind = materialKind(
      entry.item,
      turnOutcome === "completed" && index === finalAssistantIndex,
    );
    if (kind) {
      completedCompactions = 0;
      lastMaterialProgressAt = validTimestamp(entry.timestamp);
      lastMaterialProgressKind = kind;
      continue;
    }
    if (entry.item.type === "compaction" && entry.item.status === "completed") {
      completedCompactions += 1;
    }
  }

  if (completedCompactions >= 2) {
    return {
      state: "stalled",
      completedCompactionsSinceMaterialProgress: completedCompactions,
      lastMaterialProgressAt,
      lastMaterialProgressKind,
      reason:
        completedCompactions === 2
          ? "Two compactions completed without later material progress."
          : `${completedCompactions} compactions completed without later material progress.`,
    };
  }
  if (completedCompactions === 1) {
    return {
      state: "warning",
      completedCompactionsSinceMaterialProgress: 1,
      lastMaterialProgressAt,
      lastMaterialProgressKind,
      reason: "One compaction completed without later material progress.",
    };
  }
  if (lastMaterialProgressKind) {
    return {
      state: "progressing",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt,
      lastMaterialProgressKind,
      reason: "Material progress followed the latest user message.",
    };
  }
  return noProgress("No material progress has been recorded for the current continuation.");
}
