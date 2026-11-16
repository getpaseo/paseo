import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { AcpUpdate, Step, Tool } from "./wire.js";

type ToolItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

export function toolItem(step: Step, id: string): ToolItem {
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
  if (!step.tool_info) return { type: "plain_text", label: step.tool_name, text: "" };
  return nativeToolDetail(step.tool_info);
}

function nativeToolDetail(info: Tool): ProviderToolCallDetail {
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

interface HistoryOptions {
  conversationId: string;
  systemPrompt?: string;
}
type HistoryTool = Extract<AcpUpdate, { sessionUpdate: "tool_call" }>;
interface HistoryMessage {
  type: "user_message" | "assistant_message" | "reasoning";
  text: string;
}
type HistoryEntry = HistoryMessage | { type: "tool"; tool: HistoryTool };

const historyText = {
  user_message_chunk: "user_message",
  agent_message_chunk: "assistant_message",
  agent_thought_chunk: "reasoning",
} as const;

/**
 * Folds a replayed ACP conversation into the items live turns produce: consecutive chunks of one
 * kind form one message, and a tool call takes its final state at its first position.
 */
export function historyItems(
  updates: AcpUpdate[],
  options: HistoryOptions,
): ProviderTimelineItem[] {
  const entries: HistoryEntry[] = [];
  const tools = new Map<string, HistoryTool>();
  for (const update of updates) {
    if (update.sessionUpdate === "tool_call") {
      tools.set(update.toolCallId, update);
      entries.push({ type: "tool", tool: update });
    } else if (update.sessionUpdate === "tool_call_update") {
      const tool = tools.get(update.toolCallId);
      if (!tool) continue;
      if (update.name !== undefined) tool.name = update.name;
      if (update.args !== undefined) tool.args = update.args;
      if (update.status !== undefined) tool.status = update.status;
      if (update.content !== undefined) tool.content = update.content;
    } else {
      const type = historyText[update.sessionUpdate];
      const text = update.content.type === "text" ? update.content.text : "";
      const last = entries.at(-1);
      if (last && last.type === type) last.text += text;
      else entries.push({ type, text });
    }
  }
  // Paseo prefixes the system prompt to a new conversation's first native message.
  const prefix = options.systemPrompt ? `${options.systemPrompt}\n\n` : null;
  const first = entries.find((entry): entry is HistoryMessage => entry.type === "user_message");
  if (first && prefix && first.text.startsWith(prefix))
    first.text = first.text.slice(prefix.length);
  const kept = entries.filter((entry) => entry.type === "tool" || entry.text.length > 0);
  return kept.map((entry, index) => {
    const id = `${options.conversationId}:history:${index}`;
    if (entry.type === "tool") return historyTool(entry.tool, id);
    if (entry.type === "reasoning") return { type: "reasoning", id, text: entry.text };
    return { type: entry.type, id, messageId: id, text: entry.text };
  });
}

function historyTool(tool: HistoryTool, id: string): ToolItem {
  const name = tool.name || "Antigravity tool";
  const text = tool.content.flatMap((part) =>
    part.type === "content" && part.content.type === "text" ? [part.content.text] : [],
  );
  const output = text.join("\n");
  const detail = nativeToolDetail({ name, parameters: tool.args, output, error: null });
  const base = { type: "tool_call" as const, id, callId: tool.toolCallId, name, detail };
  if (tool.status === "failed")
    return { ...base, status: "failed", error: output || "Antigravity tool failed" };
  // A call the conversation never finished was cut off with its turn.
  const status = tool.status === "completed" ? "completed" : "canceled";
  return { ...base, status, error: null };
}
