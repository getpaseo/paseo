import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail as mapOmpCoreToolDetail,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";

export function mapOmpToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
  context?: {
    toolCallId: string;
    mapSubagentDetail?: (baseDetail: ToolCallDetail) => ToolCallDetail;
  },
): ToolCallDetail | null {
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    const detail = mapOmpTaskDetail(toolCall.args, result);
    return context?.mapSubagentDetail?.(detail) ?? detail;
  }
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapOmpCoreToolDetail(toolCall, result);
}

function mapOmpTaskDetail(args: unknown, result: OmpToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const resultText = extractTextFromToolResult(result);
  const childSessionId = readChildSessionId(result);
  return {
    type: "sub_agent",
    subAgentType: firstString(
      argRecord.agent,
      argRecord.subAgentType,
      argRecord.agentType,
      argRecord.type,
    ),
    description: firstString(
      argRecord.description,
      argRecord.task,
      argRecord.prompt,
      argRecord.assignment,
    ),
    ...(childSessionId ? { childSessionId } : {}),
    log: resultText?.trim() ?? "",
  };
}

function mapOmpEditDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  const fallback = mapOmpCoreToolDetail(toolCall, result);
  const details = resultDetails(result);
  const filePath =
    firstString(details?.path, details?.filePath) ?? readPatchInputPath(toolCall.args);
  if (!filePath) {
    return fallback;
  }
  return {
    type: "edit",
    filePath,
    oldString: firstString(details?.oldText, details?.old_string),
    newString: firstString(details?.newText, details?.new_string),
    unifiedDiff: firstString(details?.diff),
  };
}

function mapOmpReadDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  const fallback = mapOmpCoreToolDetail(toolCall, result);
  if (!fallback || fallback.type !== "read") {
    return fallback;
  }
  const details = resultDetails(result);
  const displayContent = isRecord(details?.displayContent) ? details.displayContent : null;
  const displayText = firstString(displayContent?.text);
  if (!displayText) {
    return fallback;
  }
  return {
    ...fallback,
    content: displayText,
  };
}

function resultDetails(result: OmpToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function readChildSessionId(result: OmpToolResult): string | undefined {
  const details = resultDetails(result);
  const direct = firstString(details?.sessionFile, details?.session_file, details?.childSessionId);
  if (direct) {
    return direct;
  }
  const text = extractTextFromToolResult(result);
  return text?.match(/(?:session|transcript)(?: file)?:\s*(?<path>\/\S+\.jsonl)/i)?.groups?.path;
}

function readPatchInputPath(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const input = args.input;
  if (typeof input !== "string") {
    return undefined;
  }
  const match = /^\[(?<path>.+?)#[^\]\n]+]/m.exec(input);
  return match?.groups?.path;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
