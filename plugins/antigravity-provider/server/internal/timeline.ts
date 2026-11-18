import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { Step } from "./wire.js";

const fileToolTypes: Readonly<Record<string, "read" | "write" | "edit">> = {
  view_file: "read",
  read_file: "read",
  write_to_file: "write",
  write_file: "write",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  edit_file: "edit",
};

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
  const child = step.subagent_info?.subagents[0];
  if (child) {
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
  if (info.name === "run_command" && typeof info.parameters.CommandLine === "string") {
    return { type: "shell", command: info.parameters.CommandLine, output: info.output };
  }
  const fileDetail = resolveFileToolDetail(info);
  if (fileDetail) return fileDetail;
  if (info.name === "search_web" && typeof info.parameters.query === "string") {
    return {
      type: "search",
      query: info.parameters.query,
      toolName: "web_search",
      content: info.output,
    };
  }
  // Native frames summarize writes; they do not carry the file contents or diff.
  return { type: "unknown", input: info.parameters, output: info.error || info.output };
}

function resolveFileToolDetail(
  info: NonNullable<Step["tool_info"]>,
): ProviderToolCallDetail | null {
  const kind = fileToolTypes[info.name];
  const filePath =
    info.parameters.AbsolutePath || info.parameters.TargetFile || info.parameters.Path;
  if (!kind || typeof filePath !== "string") return null;
  if (kind === "read") return { type: "read", filePath, content: info.output };
  return { type: kind, filePath };
}
