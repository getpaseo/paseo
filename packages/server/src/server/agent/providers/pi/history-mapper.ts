import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import {
  createPiExtensionHost,
  type PiExtensionEventOutput,
  type PiExtensionHost,
} from "./extensions/index.js";
import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

export interface PiCapturedUserMessageEntry {
  id: string;
  text: string;
}

export interface PiHistoryMapperHooks {
  mapCustomMessage?: (
    text: string,
    provider: string,
  ) => Extract<AgentStreamEvent, { type: "timeline" }> | null;
  resolveToolCallId?: (toolCallId: string, toolCall: PiTrackedToolCall) => string;
  mapToolDetail?: (
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
    context: { toolCallId: string },
  ) => ToolCallDetail | null;
}

function isTextContentBlock(block: unknown): block is PiTextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    !Array.isArray(block) &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
  );
}

export function getUserMessageText(content: string | (PiTextContent | PiImageContent)[]): string {
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

export class PiHistoryMapper {
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private readonly hydrations: Promise<AgentStreamEvent[]>[] = [];
  private userIndex = 0;
  private assistantIndex = 0;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly PiCapturedUserMessageEntry[] = [],
    private readonly hooks: PiHistoryMapperHooks = {},
    private readonly extensionHost: PiExtensionHost = createPiExtensionHost(),
  ) {}

  mapMessages(messages: readonly PiAgentMessage[]): AgentStreamEvent[] {
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
          events.push(...this.mapToolResultMessage(message));
          break;
        }
        case "bashExecution":
          events.push(this.mapBashExecutionMessage(message));
          break;
      }
    }

    return events;
  }

  async hydrate(): Promise<AgentStreamEvent[]> {
    return (await Promise.all(this.hydrations)).flat();
  }

  private mapUserMessage(message: Extract<PiAgentMessage, { role: "user" }>): AgentStreamEvent[] {
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
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): AgentStreamEvent[] {
    const extensionMapping = this.extensionHost.mapCustomMessage(message);
    const extensionEvents = this.extensionEvents(extensionMapping);
    const text = getUserMessageText(message.content);
    const mappedEvent = text ? this.hooks.mapCustomMessage?.(text, this.provider) : null;
    if (mappedEvent) {
      return [...extensionEvents, mappedEvent];
    }
    return [
      ...extensionEvents,
      ...(text
        ? [
            {
              type: "timeline",
              provider: this.provider,
              item: { type: "assistant_message", text },
            } as AgentStreamEvent,
          ]
        : []),
    ];
  }

  private mapAssistantMessage(
    message: Extract<PiAgentMessage, { role: "assistant" }>,
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
        const mapping = this.extensionHost.mapToolCall({
          callId: content.id,
          toolName: tracked.toolName,
          args: tracked.args,
          status: "running",
          result: null,
        });
        const detail = this.mapToolDetail(content.id, tracked, null, mapping?.detail);
        if (!detail) {
          continue;
        }
        events.push({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "tool_call",
            callId: this.resolveToolCallId(content.id, tracked),
            name: mapping?.name ?? tracked.toolName,
            status: "running",
            detail,
            error: null,
          },
        });
        events.push(...this.extensionEvents(mapping));
      }
    }
    return events;
  }

  private mapToolResultMessage(
    message: Extract<PiAgentMessage, { role: "toolResult" }>,
  ): AgentStreamEvent[] {
    const tracked =
      this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
    this.pendingToolCalls.delete(message.toolCallId);
    const result = parseToolResult({ content: message.content, details: message.details });
    const mapping = this.extensionHost.mapToolCall({
      callId: message.toolCallId,
      toolName: tracked.toolName,
      args: tracked.args,
      status: message.isError ? "failed" : "completed",
      result,
    });
    const detail = this.mapToolDetail(message.toolCallId, tracked, result, mapping?.detail);
    if (!detail) {
      return [];
    }
    return [
      {
        type: "timeline",
        provider: this.provider,
        item: toToolResultTimelineItem({
          callId: this.resolveToolCallId(message.toolCallId, tracked),
          name: mapping?.name ?? tracked.toolName,
          isError: Boolean(message.isError),
          detail,
          errorText: extractTextFromToolResult(result) ?? "Tool call failed",
        }),
      },
      ...this.extensionEvents(mapping),
    ];
  }

  private extensionEvents(mapping: PiExtensionEventOutput | undefined): AgentStreamEvent[] {
    if (!mapping) return [];
    this.hydrations.push(mapping.hydration);
    return mapping.events;
  }

  private mapBashExecutionMessage(
    message: Extract<PiAgentMessage, { role: "bashExecution" }>,
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
        callId: `pi-bash-${message.timestamp}`,
        name: "bash",
        status: message.cancelled ? "canceled" : "completed",
        detail,
        error: null,
      },
    };
  }

  private resolveToolCallId(toolCallId: string, toolCall: PiTrackedToolCall): string {
    return this.hooks.resolveToolCallId?.(toolCallId, toolCall) ?? toolCallId;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
    extensionDetail?: ToolCallDetail,
  ): ToolCallDetail | null {
    const hook = this.hooks.mapToolDetail;
    return hook
      ? hook(toolCall, result, { toolCallId })
      : (extensionDetail ?? mapToolDetail(toolCall, result));
  }
}

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
  userEntries: readonly PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
  // At most eight 2 MiB child files per replay; remaining cards keep their summaries.
  extensionHost: PiExtensionHost = createPiExtensionHost(undefined, undefined, 16 * 1024 * 1024),
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const mapper = new PiHistoryMapper(provider, userEntries, hooks, extensionHost);
  for (const event of mapper.mapMessages(messages)) {
    if (signal?.aborted) return;
    if (event) {
      yield event;
    }
  }
  for (const event of await mapper.hydrate()) {
    if (signal?.aborted) return;
    yield event;
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
