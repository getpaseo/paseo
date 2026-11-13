import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { Step } from "./wire.js";

export type ToolJsonValue = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

export function toolItem(
  step: Step,
  id: string,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const detail = toolDetail(step);
  const name = step.tool_name || "Antigravity tool";
  const metadata = step.subagent_info ? { subagents: step.subagent_info.subagents } : undefined;
  const base = { type: "tool_call" as const, id, callId: id, name, detail, metadata };
  if (step.state === "ERROR") {
    const error =
      step.tool_info && step.tool_info.error
        ? step.tool_info.error.message
        : "Antigravity tool failed";
    return { ...base, status: "failed", error };
  }
  const status = step.state === "ACTIVE" ? "running" : "completed";
  return { ...base, status, error: null };
}

function readString(value: ToolJsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNonEmptyString(value: ToolJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveFilePath(parameters: Readonly<Record<string, ToolJsonValue>>): string | undefined {
  return (
    readNonEmptyString(parameters.AbsolutePath) ??
    readNonEmptyString(parameters.TargetFile) ??
    readNonEmptyString(parameters.Path)
  );
}

const READ_TOOLS = new Set(["view_file", "read_file"]);
const WRITE_TOOLS = new Set(["write_to_file", "write_file"]);
const EDIT_TOOLS = new Set(["replace_file_content", "multi_replace_file_content", "edit_file"]);

function mapFileToolDetail(
  name: string,
  filePath: string,
  parameters: Readonly<Record<string, ToolJsonValue>>,
  output?: string,
): ProviderToolCallDetail | undefined {
  if (READ_TOOLS.has(name)) {
    const detail: ProviderToolCallDetail = { type: "read", filePath };
    if (output !== undefined) detail.content = output;
    return detail;
  }
  if (WRITE_TOOLS.has(name)) {
    const detail: ProviderToolCallDetail = { type: "write", filePath };
    const content = readString(parameters.Content) ?? readString(parameters.CodeContent);
    if (content !== undefined) detail.content = content;
    return detail;
  }
  if (EDIT_TOOLS.has(name)) {
    const detail: ProviderToolCallDetail = { type: "edit", filePath };
    const oldString = readString(parameters.Target) ?? readString(parameters.TargetContent);
    const newString =
      readString(parameters.Replacement) ?? readString(parameters.ReplacementContent);
    if (oldString !== undefined) detail.oldString = oldString;
    if (newString !== undefined) detail.newString = newString;
    return detail;
  }
  return undefined;
}

export function mapToolDetail(
  name: string,
  parameters: Readonly<Record<string, ToolJsonValue>>,
  output?: string,
  error?: ToolJsonValue,
): ProviderToolCallDetail {
  if (name === "run_command") {
    const command = readNonEmptyString(parameters.CommandLine);
    if (command !== undefined) {
      const detail: ProviderToolCallDetail = { type: "shell", command };
      if (output !== undefined) detail.output = output;
      return detail;
    }
  }
  const filePath = resolveFilePath(parameters);
  if (filePath !== undefined) {
    const detail = mapFileToolDetail(name, filePath, parameters, output);
    if (detail) return detail;
  }
  return {
    type: "unknown",
    input: { ...parameters },
    output: error !== undefined ? error : (output ?? null),
  };
}

function toolDetail(step: Step): ProviderToolCallDetail {
  if (step.subagent_info) {
    const child = step.subagent_info.subagents[0];
    if (child)
      return {
        type: "sub_agent",
        subAgentType: child.type_name,
        description: child.initial_prompt,
        childSessionId: child.conversation_id === null ? undefined : child.conversation_id,
        log: child.log_uri,
      };
  }
  const info = step.tool_info;
  if (!info) return { type: "plain_text", label: step.tool_name, text: "" };
  // Native frames summarize writes; they do not carry the file contents or diff.
  return mapToolDetail(info.name, info.parameters, info.output, info.error ?? undefined);
}
