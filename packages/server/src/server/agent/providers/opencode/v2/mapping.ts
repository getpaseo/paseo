import { STRUCTURED_OUTPUT_TOOL } from "./structured-output.js";
import type {
  AgentInfo,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
} from "@opencode/client";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "../../../agent-sdk-types.js";
import { mapOpencodeToolCall } from "../tool-call-mapper.js";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

export function modelsFromV2(models: ModelInfo[]): AgentModelDefinition[] {
  return models
    .filter((model) => model.enabled)
    .map((model) => ({
      provider: "opencode",
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      contextWindowMaxTokens: model.limit.context,
      metadata: {
        providerId: model.providerID,
        modelId: model.id,
        supportsAttachments: model.capabilities.input.includes("image"),
        supportsToolCall: model.capabilities.tools,
        contextWindowMaxTokens: model.limit.context,
      },
      thinkingOptions: model.variants.map((variant) => ({ id: variant.id, label: variant.id })),
    }));
}

export function modesFromV2(agents: AgentInfo[]): AgentMode[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({ id: agent.id, label: agent.name, description: agent.description }));
}

export function usageFromV2(session: SessionInfo): AgentUsage {
  return {
    inputTokens: session.tokens.input,
    outputTokens: session.tokens.output,
    cachedInputTokens: session.tokens.cache.read,
    totalCostUsd: session.cost,
  };
}

function toolFromV2(tool: SessionMessageAssistantTool): AgentTimelineItem | null {
  const state = tool.state;
  const output =
    "content" in state
      ? state.content?.map((part) => (part.type === "text" ? part.text : part.uri)).join("\n")
      : undefined;
  return mapOpencodeToolCall({
    toolName: tool.name,
    callId: tool.id,
    input: state.input,
    status: state.status === "error" ? "failed" : state.status,
    output,
    error: state.status === "error" ? state.error : undefined,
    metadata: "metadata" in state ? state.metadata : undefined,
  });
}

// Keeps the same cursor for live delivery and reconciliation, so reconnect snapshots emit only missing content.
export class V2Timeline {
  private readonly content = new Map<string, string>();

  constructor(private readonly includeClientMessageId = true) {}

  messages(messages: SessionMessageInfo[]): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    let structured = false;
    let accepted = false;
    for (const message of messages) {
      const timestamp = new Date(message.time.created).toISOString();
      const push = (item: AgentTimelineItem) =>
        events.push({ type: "timeline", provider: "opencode", item, timestamp });
      if (message.type === "user") {
        structured = message.metadata?.paseoOutputSchema !== undefined;
        accepted = false;
        if (!this.content.has(message.id)) {
          this.content.set(message.id, message.text);
          const clientMessageId = message.metadata?.paseoClientMessageId;
          push({
            type: "user_message",
            text: message.text,
            messageId: message.id,
            ...(this.includeClientMessageId && typeof clientMessageId === "string"
              ? { clientMessageId }
              : {}),
          });
        }
      } else if (message.type === "assistant") {
        message.content.forEach((part, ordinal) => {
          const key = `${message.id}:${ordinal}`;
          const previous = this.content.get(key) ?? "";
          if (part.type === "tool" && part.name === STRUCTURED_OUTPUT_TOOL) {
            if (!structured || accepted || part.state.status !== "completed") return;
            const value = part.state.metadata?.paseoStructuredOutput;
            if (value === undefined) return;
            accepted = true;
            const text = JSON.stringify(value);
            if (previous === text) return;
            this.content.set(key, text);
            push({ type: "assistant_message", text, messageId: message.id });
          } else if (part.type === "text" || part.type === "reasoning") {
            if (structured && part.type === "text") return;
            // Upstream snapshots may briefly lag the volatile delta stream.
            if (part.text.length <= previous.length) return;
            if (!part.text.startsWith(previous))
              throw new Error("OpenCode changed previously emitted message content");
            this.content.set(key, part.text);
            const suffix = part.text.slice(previous.length);
            if (part.type === "text")
              push({ type: "assistant_message", text: suffix, messageId: message.id });
            else push({ type: "reasoning", text: suffix });
          } else {
            const serialized = JSON.stringify(part);
            if (serialized === previous) return;
            this.content.set(key, serialized);
            const item = toolFromV2(part);
            if (item) push(item);
          }
        });
      } else if (message.type === "compaction") {
        const status = message.status === "running" ? "loading" : "completed";
        if (this.content.get(message.id) !== status) {
          this.content.set(message.id, status);
          push({ type: "compaction", status });
        }
      }
    }
    return events;
  }
}
