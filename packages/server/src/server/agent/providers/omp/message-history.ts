import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import type { OmpAgentMessage, OmpImageContent, OmpTextContent } from "./rpc-types.js";
import { shouldDisplayOmpCustomMessage } from "./custom-message.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";

export interface OmpCapturedUserMessageEntry {
  id: string;
  text: string;
}

export interface OmpHistoryMapperHooks {
  mapCustomMessage?: (
    message: Extract<OmpAgentMessage, { role: "custom" }>,
    text: string,
    provider: string,
  ) => Extract<AgentStreamEvent, { type: "timeline" }> | null;
  resolveToolCallId?: (toolCallId: string, toolCall: OmpTrackedToolCall) => string;
  mapToolDetail?: (
    toolCall: OmpTrackedToolCall,
    result: OmpToolResult,
    context: { toolCallId: string },
  ) => ToolCallDetail | null;
}

function isTextContentBlock(block: unknown): block is OmpTextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    !Array.isArray(block) &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
  );
}

export function getUserMessageText(content: string | (OmpTextContent | OmpImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n\n");
}

export class OmpHistoryMapper {
  private readonly pendingToolCalls = new Map<string, OmpTrackedToolCall>();
  private userIndex = 0;
  private assistantIndex = 0;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly OmpCapturedUserMessageEntry[] = [],
    private readonly hooks: OmpHistoryMapperHooks = {},
  ) {}

  mapMessages(messages: readonly OmpAgentMessage[]): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    for (const message of messages) {
      switch (message.role) {
        case "user":
          events.push(...this.mapUserMessage(message));
          break;
        case "custom":
          events.push(...this.mapCustomMessage(message));
          break;
        case "assistant":
          events.push(...this.mapAssistantMessage(message));
          break;
        case "toolResult": {
          const event = this.mapToolResultMessage(message);
          if (event) {
            events.push(event);
          }
          break;
        }
        case "bashExecution":
          events.push(this.mapBashExecutionMessage(message));
          break;
      }
    }

    return events;
  }

  private mapUserMessage(message: Extract<OmpAgentMessage, { role: "user" }>): AgentStreamEvent[] {
    const text = getUserMessageText(message.content);
    this.userIndex += 1;
    if (!text) {
      return [];
    }
    const userEntry = this.userEntries[this.userIndex - 1];
    return [
      {
        type: "timeline",
        provider: this.provider,
        item: {
          type: "user_message",
          text,
          ...(userEntry ? { messageId: userEntry.id } : {}),
        },
      },
    ];
  }

  private mapCustomMessage(
    message: Extract<OmpAgentMessage, { role: "custom" }>,
  ): AgentStreamEvent[] {
    if (!shouldDisplayOmpCustomMessage(message)) {
      return [];
    }
    const text = getUserMessageText(message.content);
    const mappedEvent = text ? this.hooks.mapCustomMessage?.(message, text, this.provider) : null;
    if (mappedEvent) {
      return [mappedEvent];
    }
    return text
      ? [
          {
            type: "timeline",
            provider: this.provider,
            item: { type: "assistant_message", text },
          },
        ]
      : [];
  }

  private mapAssistantMessage(
    message: Extract<OmpAgentMessage, { role: "assistant" }>,
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    this.assistantIndex += 1;
    const messageId =
      message.responseId || `${this.provider}-history-assistant-${this.assistantIndex}`;
    for (const content of message.content) {
      if (content.type === "text" && content.text) {
        events.push({
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: content.text, messageId },
        });
        continue;
      }
      if (content.type === "thinking" && content.thinking) {
        events.push({
          type: "timeline",
          provider: this.provider,
          item: { type: "reasoning", text: content.thinking },
        });
        continue;
      }
      if (content.type === "toolCall") {
        const tracked = parseToolArgs(content.name, content.arguments);
        this.pendingToolCalls.set(content.id, tracked);
        const detail = this.mapToolDetail(content.id, tracked, null);
        if (!detail) {
          continue;
        }
        events.push({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "tool_call",
            callId: this.resolveToolCallId(content.id, tracked),
            name: tracked.toolName,
            status: "running",
            detail,
            error: null,
          },
        });
      }
    }
    return events;
  }

  private mapToolResultMessage(
    message: Extract<OmpAgentMessage, { role: "toolResult" }>,
  ): AgentStreamEvent | null {
    const tracked =
      this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
    this.pendingToolCalls.delete(message.toolCallId);
    const result = parseToolResult({ content: message.content, details: message.details });
    const detail = this.mapToolDetail(message.toolCallId, tracked, result);
    if (!detail) {
      return null;
    }
    return {
      type: "timeline",
      provider: this.provider,
      item: toToolResultTimelineItem({
        callId: this.resolveToolCallId(message.toolCallId, tracked),
        name: resolveToolCallName(tracked, result),
        isError: Boolean(message.isError),
        detail,
        errorText: extractTextFromToolResult(result) ?? "Tool call failed",
      }),
    };
  }

  private mapBashExecutionMessage(
    message: Extract<OmpAgentMessage, { role: "bashExecution" }>,
  ): AgentStreamEvent {
    const detail: ToolCallDetail = {
      type: "shell",
      command: message.command,
      output: message.output,
      exitCode: message.exitCode ?? null,
    };
    return {
      type: "timeline",
      provider: this.provider,
      item: {
        type: "tool_call",
        callId: `omp-bash-${message.timestamp}`,
        name: "bash",
        status: message.cancelled ? "canceled" : "completed",
        detail,
        error: null,
      },
    };
  }

  private resolveToolCallId(toolCallId: string, toolCall: OmpTrackedToolCall): string {
    return this.hooks.resolveToolCallId?.(toolCallId, toolCall) ?? toolCallId;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: OmpTrackedToolCall,
    result: OmpToolResult,
  ): ToolCallDetail | null {
    const hook = this.hooks.mapToolDetail;
    return hook ? hook(toolCall, result, { toolCallId }) : mapToolDetail(toolCall, result);
  }
}

export async function* streamOmpCoreHistory(
  provider: string,
  messages: OmpAgentMessage[],
  userEntries: readonly OmpCapturedUserMessageEntry[] = [],
  hooks: OmpHistoryMapperHooks = {},
): AsyncGenerator<AgentStreamEvent> {
  const mapper = new OmpHistoryMapper(provider, userEntries, hooks);
  for (const event of mapper.mapMessages(messages)) {
    if (event) {
      yield event;
    }
  }
}

function toToolResultTimelineItem(input: {
  callId: string;
  name: string;
  isError: boolean;
  detail: ToolCallDetail;
  errorText: string;
}): AgentTimelineItem {
  if (input.isError) {
    return {
      type: "tool_call",
      callId: input.callId,
      name: input.name,
      status: "failed",
      detail: input.detail,
      error: input.errorText,
    };
  }
  return {
    type: "tool_call",
    callId: input.callId,
    name: input.name,
    status: "completed",
    detail: input.detail,
    error: null,
  };
}
