import type { OmpTrackedToolCall } from "./tool-call-detail.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readPollTargets(args: unknown): string[] | null {
  if (!isRecord(args) || !Array.isArray(args.poll)) {
    return null;
  }

  const targets: string[] = [];
  for (const target of args.poll) {
    const value = readNonEmptyString(target);
    if (!value) {
      return null;
    }
    targets.push(value);
  }
  if (targets.length === 0) {
    return null;
  }
  return targets.toSorted();
}

export function resolveOmpEmittedToolCallId(
  toolCallId: string,
  toolCall: OmpTrackedToolCall,
): string {
  if (toolCall.toolName !== "subagent") {
    return toolCallId;
  }

  const targets = readPollTargets(toolCall.args);
  if (!targets) {
    return toolCallId;
  }
  return `omp-poll:${targets.join(",")}`;
}
