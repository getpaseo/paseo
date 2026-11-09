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
  const base = {
    type: "tool_call" as const,
    id,
    callId: id,
    name,
    detail,
    metadata,
  };
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

type ToolInfo = NonNullable<Step["tool_info"]>;

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
  if (info.name === "run_command" && typeof info.parameters.CommandLine === "string") {
    return {
      type: "shell",
      command: info.parameters.CommandLine,
      output: info.output,
    };
  }
  if (info.name === "search_web" && typeof info.parameters.query === "string") {
    return {
      type: "search",
      query: info.parameters.query,
      toolName: "web_search",
      content: info.output,
    };
  }
  const filePath =
    info.parameters.Path || info.parameters.AbsolutePath || info.parameters.TargetFile;
  if (typeof filePath === "string") {
    const mapped = fileToolDetail(info, filePath);
    if (mapped) return mapped;
  }
  return {
    type: "unknown",
    input: info.parameters,
    output: info.error || info.output,
  };
}

function fileToolDetail(info: ToolInfo, filePath: string): ProviderToolCallDetail | null {
  if (info.name === "read_file" || info.name === "view_file") {
    const startLine =
      typeof info.parameters.StartLine === "number" ? info.parameters.StartLine : undefined;
    const endLine =
      typeof info.parameters.EndLine === "number" ? info.parameters.EndLine : undefined;
    const limit =
      startLine !== undefined && endLine !== undefined && endLine >= startLine
        ? endLine - startLine + 1
        : undefined;
    return {
      type: "read",
      filePath,
      content: info.output,
      ...(startLine === undefined ? {} : { offset: startLine }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  if (info.name === "write_file" || info.name === "write_to_file") {
    return {
      type: "write",
      filePath,
      ...(typeof info.parameters.Content === "string" ? { content: info.parameters.Content } : {}),
    };
  }
  if (
    info.name === "edit_file" ||
    info.name === "replace_file_content" ||
    info.name === "multi_replace_file_content"
  ) {
    return {
      type: "edit",
      filePath,
      ...(typeof info.parameters.Target === "string" ? { oldString: info.parameters.Target } : {}),
      ...(typeof info.parameters.Replacement === "string"
        ? { newString: info.parameters.Replacement }
        : {}),
    };
  }
  return null;
}
