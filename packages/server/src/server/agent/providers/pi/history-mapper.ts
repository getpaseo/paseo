import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";
import {
  MAX_SUBAGENT_TIMELINE_ROWS,
  findPiSubagentCallArgs,
  piSubagentDescriptorId,
  readPiSubagentInlineOutput,
  readPiSubagentLaunchArgs,
  readPiSubagentRunPayload,
  streamPiChildSessionItems,
} from "./subagent-run.js";

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
  /** Invoked when a child session file fails to read during subagent replay. */
  onSubagentReplayError?: (error: unknown, sessionFile: string) => void;
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
  private userIndex = 0;
  private assistantIndex = 0;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly PiCapturedUserMessageEntry[] = [],
    private readonly hooks: PiHistoryMapperHooks = {},
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
    const text = getUserMessageText(message.content);
    const mappedEvent = text ? this.hooks.mapCustomMessage?.(text, this.provider) : null;
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
    message: Extract<PiAgentMessage, { role: "toolResult" }>,
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
  ): ToolCallDetail | null {
    const hook = this.hooks.mapToolDetail;
    return hook ? hook(toolCall, result, { toolCallId }) : mapToolDetail(toolCall, result);
  }
}

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
  userEntries: readonly PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
): AsyncGenerator<AgentStreamEvent> {
  const mapper = new PiHistoryMapper(provider, userEntries, hooks);
  for (const event of mapper.mapMessages(messages)) {
    if (event) {
      yield event;
    }
  }
  yield* streamPiSubagentHistory(provider, messages, hooks);
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

const MAX_REPLAYED_SUBAGENT_ROWS = MAX_SUBAGENT_TIMELINE_ROWS;

/**
 * Replay pi-subagents runs recorded in parent history. Each completed
 * `subagent` tool result carries its run payload in `details` with child
 * session files; those replays become provider subagent descriptors plus
 * timeline rows so restored sessions keep their Subagents Track. Results with
 * no run payload (details stripped) still get a descriptor backed by the
 * inline tool output.
 */
async function* streamPiSubagentHistory(
  provider: string,
  messages: readonly PiAgentMessage[],
  hooks: PiHistoryMapperHooks,
): AsyncGenerator<AgentStreamEvent> {
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "subagent") {
      continue;
    }
    const run = readPiSubagentRunPayload(
      message.details === undefined
        ? { content: message.content }
        : { content: message.content, details: message.details },
    );
    if (run) {
      const presentation = subagentPresentation(messages, message, run);
      yield subagentUpsertEvent(provider, presentation, "running", message.toolCallId);

      yield* replaySubagentRows(provider, presentation.descriptorId, run, message, hooks);

      yield subagentUpsertEvent(provider, presentation, presentation.status, message.toolCallId);
      continue;
    }
    // No run payload (details stripped by pi-subagents). Still surface the run
    // as a descriptor backed by the inline output so the track does not lose
    // subagents that are visible in the transcript.
    const text = readPiSubagentInlineOutput({
      content: message.content,
      ...(message.details === undefined ? {} : { details: message.details }),
    });
    if (!text) {
      continue;
    }
    const failed = message.isError === true;
    yield {
      type: "provider_subagent",
      provider,
      event: {
        type: "upsert",
        id: message.toolCallId,
        title: "Pi subagent",
        description: null,
        status: "running",
        toolCallId: message.toolCallId,
      },
    };
    yield {
      type: "provider_subagent",
      provider,
      event: {
        type: "timeline",
        id: message.toolCallId,
        item: { type: "assistant_message", text },
      },
    };
    yield {
      type: "provider_subagent",
      provider,
      event: {
        type: "upsert",
        id: message.toolCallId,
        title: "Pi subagent",
        description: null,
        status: failed ? "failed" : "completed",
        toolCallId: message.toolCallId,
      },
    };
  }
}

function subagentUpsertEvent(
  provider: string,
  presentation: {
    descriptorId: string;
    title: string;
    description: string | null;
    status: "completed" | "failed" | "running";
  },
  status: "completed" | "failed" | "running",
  toolCallId: string,
): AgentStreamEvent {
  return {
    type: "provider_subagent",
    provider,
    event: {
      type: "upsert",
      id: presentation.descriptorId,
      title: presentation.title,
      description: presentation.description,
      status,
      toolCallId,
    },
  };
}

function subagentPresentation(
  messages: readonly PiAgentMessage[],
  message: Extract<PiAgentMessage, { role: "toolResult" }>,
  run: {
    runId?: string;
    asyncId?: string;
    results: Array<{ agent?: string; task?: string; exitCode?: number; error?: string }>;
  },
): {
  descriptorId: string;
  title: string;
  description: string | null;
  status: "completed" | "failed";
} {
  const launchArgs = findPiSubagentCallArgs(messages, message.toolCallId);
  const launch = readPiSubagentLaunchArgs(launchArgs);
  const failed =
    message.isError === true ||
    run.results.some(
      (entry) => Boolean(entry.error) || (entry.exitCode !== undefined && entry.exitCode !== 0),
    );
  return {
    descriptorId: piSubagentDescriptorId(message.toolCallId, run),
    title: firstText(launch?.agent, ...run.results.map((entry) => entry.agent)) ?? "Pi subagent",
    description: firstText(launch?.task, ...run.results.map((entry) => entry.task)) ?? null,
    status: failed ? "failed" : "completed",
  };
}

async function* replaySubagentRows(
  provider: string,
  descriptorId: string,
  run: { results: Array<{ sessionFile?: string }> },
  message: Extract<PiAgentMessage, { role: "toolResult" }>,
  hooks: PiHistoryMapperHooks,
): AsyncGenerator<AgentStreamEvent> {
  let rows = 0;
  for (const entry of run.results) {
    if (!entry.sessionFile || rows >= MAX_REPLAYED_SUBAGENT_ROWS) {
      continue;
    }
    try {
      for await (const { item, timestamp: rowTimestamp } of streamPiChildSessionItems(
        entry.sessionFile,
      )) {
        if (rows >= MAX_REPLAYED_SUBAGENT_ROWS) {
          break;
        }
        rows += 1;
        yield {
          type: "provider_subagent",
          provider,
          event: {
            type: "timeline",
            id: descriptorId,
            item,
            ...(rowTimestamp ? { timestamp: rowTimestamp } : {}),
          },
        };
      }
    } catch (error) {
      // Child transcripts are best-effort replay data; a missing or corrupt
      // file must not fail the whole history stream.
      hooks.onSubagentReplayError?.(error, entry.sessionFile!);
    }
  }
  if (rows === 0) {
    const text = readPiSubagentInlineOutput({
      content: message.content,
      ...(message.details === undefined ? {} : { details: message.details }),
    });
    if (text) {
      yield {
        type: "provider_subagent",
        provider,
        event: {
          type: "timeline",
          id: descriptorId,
          item: { type: "assistant_message", text },
        },
      };
    }
  }
}

function firstText(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
