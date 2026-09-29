import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { deriveCodexToolDetail } from "../codex/tool-call-detail-parser.js";
import type { OmpBridgedToolIdentity } from "./mcp-bridge.js";
import {
  extractTextFromToolResult,
  mapToolDetail as mapOmpCoreToolDetail,
  resolveToolCallName,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";

export function mapOmpToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
  context?: {
    toolCallId: string;
    bridgedTool?: OmpBridgedToolIdentity;
    mapSubagentDetail?: (baseDetail: ToolCallDetail) => ToolCallDetail;
  },
): ToolCallDetail | null {
  if (context?.bridgedTool) {
    return deriveCodexToolDetail({
      name: `${context.bridgedTool.server}.${context.bridgedTool.tool}`,
      input: toolCall.args,
      output: result,
    });
  }
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    const detail = mapOmpTaskDetail(toolCall.args, result);
    return context?.mapSubagentDetail?.(detail) ?? detail;
  }
  const deviceDetail = mapOmpDeviceToolDetail(toolCall, result);
  if (deviceDetail) return deviceDetail;
  const extended = mapOmpExtendedToolDetail(toolCall, result);
  if (extended) return extended;
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapOmpCoreToolDetail(toolCall, result);
}

function mapOmpDeviceToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  if (toolCall.kind !== "write" || !toolCall.args.path.startsWith("xd://")) return null;
  const toolName = resolveToolCallName(toolCall, result);
  if (!OPAQUE_TEXT_TOOLS.has(toolName) && toolName !== "ast_grep") return null;
  let args: unknown;
  try {
    args = JSON.parse(toolCall.args.content);
  } catch {
    args = null;
  }
  return mapOmpExtendedToolDetail({ kind: "unknown", toolName, args }, result);
}

function mapOmpExtendedToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  if (toolCall.toolName === "yield") {
    return {
      type: "plain_text",
      label: "Submitted subagent result",
      text: extractTextFromToolResult(result),
    };
  }
  if (toolCall.toolName === "wait") {
    return mapOmpWaitDetail(result);
  }
  if (toolCall.toolName === "web_search") {
    const args = isRecord(toolCall.args) ? toolCall.args : {};
    return {
      type: "search",
      query: firstString(args.query) ?? "Web search",
      toolName: "web_search",
      content: extractTextFromToolResult(result),
    };
  }
  if (toolCall.toolName === "ask" || toolCall.toolName === "ask_user") {
    return mapOmpAskDetail(toolCall.args, result);
  }
  if (toolCall.toolName === "glob" || toolCall.toolName === "ast_grep") {
    const args = isRecord(toolCall.args) ? toolCall.args : {};
    return {
      type: "search",
      query: firstString(args.pattern, args.pat, args.query) ?? toolCall.toolName,
      ...(toolCall.toolName === "glob" ? { toolName: "glob" as const } : {}),
      content: extractTextFromToolResult(result),
    };
  }
  if (toolCall.toolName === "think") {
    const args = isRecord(toolCall.args) ? toolCall.args : {};
    return { type: "plain_text", label: "Thinking", text: firstString(args.thoughts) };
  }
  return mapOmpOpaqueToolDetail(toolCall, result);
}

function mapOmpWaitDetail(result: OmpToolResult): ToolCallDetail {
  const text = extractTextFromToolResult(result)?.trim();
  const jobs = resultDetails(result)?.jobs;
  const firstJob = Array.isArray(jobs) ? jobs.find(isRecord) : undefined;
  const jobType = firstString(firstJob?.type);
  const jobStatus = firstString(firstJob?.status);
  const jobLabel = firstString(firstJob?.label, firstJob?.id);
  const label =
    jobType && jobStatus && jobLabel
      ? `${jobType} ${jobStatus}: ${jobLabel}`
      : (text?.split("\n", 1)[0] ?? "Waiting for background work");
  return {
    type: "plain_text",
    label,
    text: firstString(firstJob?.resultText, firstJob?.errorText) ?? text,
  };
}

function mapOmpAskDetail(rawArgs: unknown, result: OmpToolResult): ToolCallDetail {
  const args = isRecord(rawArgs) ? rawArgs : {};
  const firstQuestion = Array.isArray(args.questions) ? args.questions[0] : undefined;
  const askedQuestion = isRecord(firstQuestion) ? firstString(firstQuestion.question) : undefined;
  const details =
    result && typeof result !== "string" && isRecord(result.details) ? result.details : {};
  const answers = Array.isArray(details.results) ? details.results : [details];
  const lines = answers.flatMap((answer) => {
    if (!isRecord(answer)) return [];
    const question = firstString(answer.question);
    const selected = Array.isArray(answer.selectedOptions)
      ? answer.selectedOptions.filter((option): option is string => typeof option === "string")
      : [];
    const response =
      [...selected, firstString(answer.customInput)].filter(Boolean).join(", ") || "No selection";
    return question ? [`${question}\n${response}`] : [];
  });
  const text = lines.length ? lines.join("\n\n") : extractTextFromToolResult(result);
  return {
    type: "plain_text",
    label: firstString(details.question, askedQuestion, args.question, args.title) ?? "Question",
    text,
  };
}

function mapOmpOpaqueToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  if (OPAQUE_TEXT_TOOLS.has(toolCall.toolName)) {
    const args = isRecord(toolCall.args) ? toolCall.args : {};
    const action = firstString(args.action, args.op, args.operation, args.command);
    const target = firstString(args.name, args.goal, args.path, args.query, args.id, args.report);
    const label =
      [action, target].filter(Boolean).join(" ") || toolCall.toolName.replaceAll("_", " ");
    return { type: "plain_text", label, text: extractTextFromToolResult(result) };
  }
  return null;
}

const OPAQUE_TEXT_TOOLS = new Set([
  "ast_edit",
  "debug",
  "eval",
  "github",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
  "yield",
  "goal",
]);

function mapOmpTaskDetail(args: unknown, result: OmpToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const firstTask = Array.isArray(argRecord.tasks) ? argRecord.tasks.find(isRecord) : undefined;
  const resultText = extractTextFromToolResult(result);
  const childSessionId = readChildSessionId(result);
  return {
    type: "sub_agent",
    subAgentType: firstString(
      firstTask?.name,
      argRecord.name,
      argRecord.agent,
      argRecord.subAgentType,
      argRecord.agentType,
      argRecord.type,
    ),
    description: firstString(
      argRecord.i,
      taskInstructionSummary(firstTask?.task),
      argRecord.description,
      argRecord.task,
      argRecord.prompt,
      argRecord.assignment,
    ),
    ...(childSessionId ? { childSessionId } : {}),
    log: resultText?.trim() ?? "",
  };
}

function taskInstructionSummary(value: unknown): string | undefined {
  const instruction = firstString(value);
  if (!instruction) return undefined;
  return instruction
    .split("\n")
    .map((line) => line.replace(/^#+\s*(?:Target|Goal|Task)\s*/i, "").trim())
    .find(Boolean);
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
