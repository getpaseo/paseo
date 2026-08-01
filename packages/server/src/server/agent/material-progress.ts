import { createHash } from "node:crypto";
import type { MaterialProgressPayload } from "../messages.js";
import type { AgentTimelineItem, ToolCallDetail, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { TimelineProjectionEntry } from "./timeline-projection.js";

export interface AnalyzeMaterialProgressInput {
  entries: readonly TimelineProjectionEntry[] | null;
  turnOutcome: "completed" | "failed" | "canceled" | null;
  /**
   * Manager-owned sequence at which the currently accepted continuation begins.
   * Older persisted agents omit it and retain the latest-user-message fallback.
   */
  continuationBoundarySeq?: number | null;
}

type MaterialProgressKind = NonNullable<MaterialProgressPayload["lastMaterialProgressKind"]>;

interface MaterialProgressEvent {
  kind: MaterialProgressKind;
  fingerprint: string;
}

function hasConcreteText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function progressFingerprint(kind: MaterialProgressKind, result: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  return `${kind}:${digest}`;
}

function progressEvent(kind: MaterialProgressKind, result: unknown): MaterialProgressEvent {
  return { kind, fingerprint: progressFingerprint(kind, result) };
}

type EditDetail = Extract<ToolCallDetail, { type: "edit" }>;
type WriteDetail = Extract<ToolCallDetail, { type: "write" }>;
type EvidenceDetail = Extract<ToolCallDetail, { type: "read" | "search" | "fetch" }>;
type SearchDetail = Extract<EvidenceDetail, { type: "search" }>;
type ShellDetail = Extract<ToolCallDetail, { type: "shell" }>;
type PlanDetail = Extract<ToolCallDetail, { type: "plan" }>;

function editEvent(detail: EditDetail): MaterialProgressEvent | null {
  const { filePath, oldString, newString, unifiedDiff } = detail;
  if (!hasConcreteText(unifiedDiff) && oldString === undefined && newString === undefined) {
    return null;
  }
  return progressEvent("edit", { filePath, oldString, newString, unifiedDiff });
}

function writeEvent(detail: WriteDetail): MaterialProgressEvent | null {
  const { filePath, content } = detail;
  return content === undefined ? null : progressEvent("write", { filePath, content });
}

function hasSearchResult(detail: SearchDetail): boolean {
  return (
    hasConcreteText(detail.content) ||
    detail.numFiles !== undefined ||
    detail.numMatches !== undefined ||
    (detail.filePaths?.length ?? 0) > 0 ||
    (detail.webResults?.length ?? 0) > 0 ||
    (detail.annotations?.length ?? 0) > 0
  );
}

function evidenceEvent(detail: EvidenceDetail): MaterialProgressEvent | null {
  switch (detail.type) {
    case "read": {
      const { filePath, content } = detail;
      return hasConcreteText(content)
        ? progressEvent("evidence", { type: "read", filePath, content })
        : null;
    }
    case "search": {
      const { query, content, filePaths, webResults, annotations, numFiles, numMatches } = detail;
      return hasSearchResult(detail)
        ? progressEvent("evidence", {
            type: "search",
            query,
            content,
            filePaths,
            webResults,
            annotations,
            numFiles,
            numMatches,
          })
        : null;
    }
    case "fetch": {
      const { url, result, code, bytes } = detail;
      const succeeded =
        hasConcreteText(result) && (code === undefined || (code >= 200 && code < 400));
      return succeeded
        ? progressEvent("evidence", { type: "fetch", url, result, code, bytes })
        : null;
    }
  }
}

function verificationEvent(detail: ShellDetail): MaterialProgressEvent | null {
  const { command, cwd, output, exitCode } = detail;
  return exitCode === 0 && hasConcreteText(output)
    ? progressEvent("verification", { command, cwd, output, exitCode })
    : null;
}

function decisionEvent(detail: PlanDetail): MaterialProgressEvent | null {
  const text = detail.text.trim();
  return text ? progressEvent("decision", text) : null;
}

function materialToolEvent(item: ToolCallTimelineItem): MaterialProgressEvent | null {
  if (item.status !== "completed") return null;
  switch (item.detail.type) {
    case "edit":
      return editEvent(item.detail);
    case "write":
      return writeEvent(item.detail);
    case "read":
    case "search":
    case "fetch":
      return evidenceEvent(item.detail);
    case "shell":
      return verificationEvent(item.detail);
    case "plan":
      return decisionEvent(item.detail);
    case "worktree_setup":
    case "sub_agent":
    case "unknown":
    case "plain_text":
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

function currentContinuation(
  ordered: readonly TimelineProjectionEntry[],
  continuationBoundarySeq: number | null | undefined,
): TimelineProjectionEntry[] | null {
  if (continuationBoundarySeq != null) {
    return ordered.filter((entry) => entry.seqEnd >= continuationBoundarySeq);
  }

  let latestUserIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.item.type === "user_message") latestUserIndex = index;
  }
  return latestUserIndex < 0 ? null : ordered.slice(latestUserIndex + 1);
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

function materialEvent(
  item: AgentTimelineItem,
  isFinalTerminalAssistant: boolean,
): MaterialProgressEvent | null {
  if (item.type === "tool_call") return materialToolEvent(item);
  if (item.type === "assistant_message" && isFinalTerminalAssistant && hasConcreteText(item.text)) {
    const text = item.text.trim();
    return {
      kind: "assistant_result",
      fingerprint: progressFingerprint("assistant_result", text),
    };
  }
  return null;
}

export function analyzeMaterialProgress({
  entries,
  turnOutcome,
  continuationBoundarySeq,
}: AnalyzeMaterialProgressInput): MaterialProgressPayload {
  if (entries === null) return noProgress("Timeline history is unavailable.");

  const ordered = orderedEntries(entries);
  const continuation = currentContinuation(ordered, continuationBoundarySeq);
  if (continuation === null) return noProgress("No current continuation is available.");
  let finalAssistantIndex = -1;
  if (turnOutcome === "completed") {
    for (let index = 0; index < continuation.length; index += 1) {
      if (continuation[index]?.item.type === "assistant_message") finalAssistantIndex = index;
    }
  }

  let completedCompactions = 0;
  let lastMaterialProgressAt: string | null = null;
  let lastMaterialProgressKind: MaterialProgressKind | null = null;
  const seenProgress = new Set<string>();

  for (let index = 0; index < continuation.length; index += 1) {
    const entry = continuation[index];
    if (!entry) continue;
    const event = materialEvent(
      entry.item,
      turnOutcome === "completed" && index === finalAssistantIndex,
    );
    if (event && !seenProgress.has(event.fingerprint)) {
      seenProgress.add(event.fingerprint);
      completedCompactions = 0;
      lastMaterialProgressAt = validTimestamp(entry.timestamp);
      lastMaterialProgressKind = event.kind;
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
