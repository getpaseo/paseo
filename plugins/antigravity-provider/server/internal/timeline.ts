import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { Step } from "./wire.js";

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
  const path = info.parameters.AbsolutePath || info.parameters.TargetFile;
  if (info.name === "run_command" && typeof info.parameters.CommandLine === "string") {
    return { type: "shell", command: info.parameters.CommandLine, output: info.output };
  }
  if (info.name === "view_file" && typeof path === "string")
    return { type: "read", filePath: path, content: info.output };
  if (info.name === "write_to_file" && typeof path === "string")
    return { type: "write", filePath: path };
  if (
    (info.name === "replace_file_content" || info.name === "multi_replace_file_content") &&
    typeof path === "string"
  )
    return { type: "edit", filePath: path };
  // Native frames summarize writes; they do not carry the file contents or diff.
  return { type: "unknown", input: info.parameters, output: info.error || info.output };
}
