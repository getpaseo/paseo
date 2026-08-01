import { createHash } from "node:crypto";
import { z } from "zod";
import type { MaterialProgressPayload } from "../messages.js";
import type { ToolCallDetail, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export type MaterialProgressKind = NonNullable<MaterialProgressPayload["lastMaterialProgressKind"]>;
export type MaterialProgressTurnOutcome = "completed" | "failed" | "canceled";

export interface MaterialProgressCheckpoint {
  timelineEpoch: string;
  continuationBoundarySeq: number | null;
  acceptedTurnId: string | null;
  turnOutcome: MaterialProgressTurnOutcome | null;
  observedThroughSeq: number;
  completedCompactionsSinceMaterialProgress: number;
  lastMaterialProgressAt: string | null;
  lastMaterialProgressKind: MaterialProgressKind | null;
  seenMaterialProgressFingerprints: string[];
  trailingAssistantFingerprint: string | null;
  trailingAssistantHasConcreteText: boolean;
  trailingAssistantAt: string | null;
  unavailableReason?: string;
}

const MaterialProgressKindSchema = z.enum([
  "edit",
  "write",
  "evidence",
  "verification",
  "decision",
  "assistant_result",
]);

export const MaterialProgressCheckpointSchema: z.ZodType<MaterialProgressCheckpoint> = z.object({
  timelineEpoch: z.string(),
  continuationBoundarySeq: z.number().int().positive().nullable(),
  acceptedTurnId: z.string().nullable(),
  turnOutcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  observedThroughSeq: z.number().int().nonnegative(),
  completedCompactionsSinceMaterialProgress: z.number().int().nonnegative(),
  lastMaterialProgressAt: z.string().nullable(),
  lastMaterialProgressKind: MaterialProgressKindSchema.nullable(),
  seenMaterialProgressFingerprints: z.array(z.string()),
  trailingAssistantFingerprint: z.string().nullable(),
  trailingAssistantHasConcreteText: z.boolean(),
  trailingAssistantAt: z.string().nullable(),
  unavailableReason: z.string().optional(),
});

interface MaterialProgressEvent {
  kind: MaterialProgressKind;
  fingerprint: string;
}

type EditDetail = Extract<ToolCallDetail, { type: "edit" }>;
type WriteDetail = Extract<ToolCallDetail, { type: "write" }>;
type EvidenceDetail = Extract<ToolCallDetail, { type: "read" | "search" | "fetch" }>;
type SearchDetail = Extract<EvidenceDetail, { type: "search" }>;
type ShellDetail = Extract<ToolCallDetail, { type: "shell" }>;
type PlanDetail = Extract<ToolCallDetail, { type: "plan" }>;

function hasConcreteText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function progressFingerprint(kind: MaterialProgressKind, result: unknown): string {
  return `${kind}:${digest(result)}`;
}

function progressEvent(kind: MaterialProgressKind, result: unknown): MaterialProgressEvent {
  return { kind, fingerprint: progressFingerprint(kind, result) };
}

function editEvent(detail: EditDetail): MaterialProgressEvent | null {
  const { filePath, oldString, newString, unifiedDiff } = detail;
  if (!hasConcreteText(unifiedDiff) && oldString !== undefined && oldString === newString) {
    return null;
  }
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

function emptyCheckpoint(input: {
  timelineEpoch: string;
  observedThroughSeq: number;
  unavailableReason?: string;
}): MaterialProgressCheckpoint {
  return {
    timelineEpoch: input.timelineEpoch,
    continuationBoundarySeq: null,
    acceptedTurnId: null,
    turnOutcome: null,
    observedThroughSeq: input.observedThroughSeq,
    completedCompactionsSinceMaterialProgress: 0,
    lastMaterialProgressAt: null,
    lastMaterialProgressKind: null,
    seenMaterialProgressFingerprints: [],
    trailingAssistantFingerprint: null,
    trailingAssistantHasConcreteText: false,
    trailingAssistantAt: null,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
  };
}

export function createMaterialProgressCheckpoint(input: {
  timelineEpoch: string;
  nextSeq: number;
}): MaterialProgressCheckpoint {
  return emptyCheckpoint({
    timelineEpoch: input.timelineEpoch,
    observedThroughSeq: Math.max(0, input.nextSeq - 1),
  });
}

export function restoreMaterialProgressCheckpoint(
  checkpoint: MaterialProgressCheckpoint,
  input: { timelineEpoch: string; nextSeq: number },
): MaterialProgressCheckpoint {
  const lastSeq = Math.max(0, input.nextSeq - 1);
  const boundaryIsValid =
    checkpoint.continuationBoundarySeq === null ||
    checkpoint.continuationBoundarySeq <= input.nextSeq;
  // Sequence bounds are not a continuity identity: replacement timelines can
  // have the same length or be longer. Only an unchanged epoch proves that the
  // checkpoint still describes these rows.
  const continuityIsProven = checkpoint.timelineEpoch === input.timelineEpoch;
  if (!continuityIsProven || !boundaryIsValid || checkpoint.observedThroughSeq > lastSeq) {
    return emptyCheckpoint({
      timelineEpoch: input.timelineEpoch,
      observedThroughSeq: lastSeq,
      unavailableReason:
        "Persisted material progress could not be proven to match the restored timeline.",
    });
  }
  return checkpoint;
}

export function invalidateMaterialProgressCheckpoint(input: {
  timelineEpoch: string;
  nextSeq: number;
  reason: string;
}): MaterialProgressCheckpoint {
  return emptyCheckpoint({
    timelineEpoch: input.timelineEpoch,
    observedThroughSeq: Math.max(0, input.nextSeq - 1),
    unavailableReason: input.reason,
  });
}

export function openMaterialProgressContinuation(input: {
  timelineEpoch: string;
  boundarySeq: number;
  turnId: string;
}): MaterialProgressCheckpoint {
  return {
    ...emptyCheckpoint({
      timelineEpoch: input.timelineEpoch,
      observedThroughSeq: Math.max(0, input.boundarySeq - 1),
    }),
    continuationBoundarySeq: input.boundarySeq,
    acceptedTurnId: input.turnId,
  };
}

function withTrailingAssistant(
  checkpoint: MaterialProgressCheckpoint,
  row: AgentTimelineRow,
): MaterialProgressCheckpoint {
  if (row.item.type !== "assistant_message") {
    return {
      ...checkpoint,
      trailingAssistantFingerprint: null,
      trailingAssistantHasConcreteText: false,
      trailingAssistantAt: null,
    };
  }
  const previous = checkpoint.trailingAssistantFingerprint;
  return {
    ...checkpoint,
    trailingAssistantFingerprint: digest(
      previous === null ? { text: row.item.text } : { previous, text: row.item.text },
    ),
    trailingAssistantHasConcreteText:
      checkpoint.trailingAssistantHasConcreteText || hasConcreteText(row.item.text),
    trailingAssistantAt: validTimestamp(row.timestamp),
  };
}

function recordMaterialEvent(
  checkpoint: MaterialProgressCheckpoint,
  event: MaterialProgressEvent | null,
  timestamp: string,
): MaterialProgressCheckpoint {
  if (!event || checkpoint.seenMaterialProgressFingerprints.includes(event.fingerprint)) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    completedCompactionsSinceMaterialProgress: 0,
    lastMaterialProgressAt: validTimestamp(timestamp),
    lastMaterialProgressKind: event.kind,
    seenMaterialProgressFingerprints: [
      ...checkpoint.seenMaterialProgressFingerprints,
      event.fingerprint,
    ],
  };
}

export function advanceMaterialProgressCheckpoint(
  checkpoint: MaterialProgressCheckpoint,
  row: AgentTimelineRow,
  timelineEpoch: string,
): MaterialProgressCheckpoint {
  if (checkpoint.timelineEpoch !== timelineEpoch) {
    return emptyCheckpoint({
      timelineEpoch,
      observedThroughSeq: row.seq,
      unavailableReason: "Material progress is unavailable because the timeline epoch changed.",
    });
  }
  if (row.seq <= checkpoint.observedThroughSeq) {
    return checkpoint;
  }
  if (row.seq !== checkpoint.observedThroughSeq + 1) {
    return emptyCheckpoint({
      timelineEpoch,
      observedThroughSeq: row.seq,
      unavailableReason: "Material progress is unavailable because timeline history is incomplete.",
    });
  }

  if (checkpoint.acceptedTurnId !== null && row.turnId !== checkpoint.acceptedTurnId) {
    return { ...checkpoint, observedThroughSeq: row.seq };
  }

  let next = withTrailingAssistant({ ...checkpoint, observedThroughSeq: row.seq }, row);
  if (checkpoint.continuationBoundarySeq === null || row.seq < checkpoint.continuationBoundarySeq) {
    return next;
  }

  const event = row.item.type === "tool_call" ? materialToolEvent(row.item) : null;
  next = recordMaterialEvent(next, event, row.timestamp);
  if (row.item.type === "compaction" && row.item.status === "completed") {
    next = {
      ...next,
      completedCompactionsSinceMaterialProgress: next.completedCompactionsSinceMaterialProgress + 1,
    };
  }
  return next;
}

export function settleMaterialProgressContinuation(
  checkpoint: MaterialProgressCheckpoint,
  input: { turnId: string; outcome: MaterialProgressTurnOutcome },
): MaterialProgressCheckpoint {
  if (checkpoint.acceptedTurnId !== input.turnId) return checkpoint;
  let next: MaterialProgressCheckpoint = { ...checkpoint, turnOutcome: input.outcome };
  if (
    input.outcome === "completed" &&
    checkpoint.trailingAssistantFingerprint !== null &&
    checkpoint.trailingAssistantHasConcreteText
  ) {
    next = recordMaterialEvent(
      next,
      {
        kind: "assistant_result",
        fingerprint: `assistant_result:${checkpoint.trailingAssistantFingerprint}`,
      },
      checkpoint.trailingAssistantAt ?? "",
    );
  }
  return next;
}

export function materialProgressPayload(
  checkpoint: MaterialProgressCheckpoint | null | undefined,
): MaterialProgressPayload {
  if (!checkpoint) {
    return {
      state: "none",
      timelineEpoch: null,
      continuationBoundarySeq: null,
      observedThroughSeq: null,
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "Material progress is unavailable from this stored agent snapshot.",
    };
  }

  const base = {
    timelineEpoch: checkpoint.timelineEpoch,
    continuationBoundarySeq: checkpoint.continuationBoundarySeq,
    observedThroughSeq: checkpoint.observedThroughSeq,
    completedCompactionsSinceMaterialProgress: checkpoint.completedCompactionsSinceMaterialProgress,
    lastMaterialProgressAt: checkpoint.lastMaterialProgressAt,
    lastMaterialProgressKind: checkpoint.lastMaterialProgressKind,
  };
  if (checkpoint.unavailableReason) {
    return { ...base, state: "none", reason: checkpoint.unavailableReason };
  }
  if (checkpoint.continuationBoundarySeq === null) {
    return {
      ...base,
      state: "none",
      reason: "No accepted continuation is available for the current timeline epoch.",
    };
  }
  if (checkpoint.completedCompactionsSinceMaterialProgress >= 2) {
    const count = checkpoint.completedCompactionsSinceMaterialProgress;
    return {
      ...base,
      state: "stalled",
      reason:
        count === 2
          ? "Two compactions completed without later distinct material progress."
          : `${count} compactions completed without later distinct material progress.`,
    };
  }
  if (checkpoint.completedCompactionsSinceMaterialProgress === 1) {
    return {
      ...base,
      state: "warning",
      reason: "One compaction completed without later distinct material progress.",
    };
  }
  if (checkpoint.lastMaterialProgressKind) {
    return {
      ...base,
      state: "progressing",
      reason: "Distinct material progress was recorded in the current accepted continuation.",
    };
  }
  return {
    ...base,
    state: "none",
    reason: "No material progress has been recorded for the current accepted continuation.",
  };
}
