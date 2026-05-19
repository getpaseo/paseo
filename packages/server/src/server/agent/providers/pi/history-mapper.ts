import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

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

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
): AsyncGenerator<AgentStreamEvent> {
  const pendingToolCalls = new Map<string, PiTrackedToolCall>();
  let userIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      const text = getUserMessageText(message.content);
      if (text) {
        yield {
          type: "timeline",
          provider,
          item: {
            type: "user_message",
            text,
            messageId: `pi-user-${userIndex}`,
          },
        };
      }
      userIndex += 1;
      continue;
    }

    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          yield {
            type: "timeline",
            provider,
            item: { type: "assistant_message", text: content.text },
          };
          continue;
        }

        if (content.type === "thinking" && content.thinking) {
          yield {
            type: "timeline",
            provider,
            item: { type: "reasoning", text: content.thinking },
          };
          continue;
        }

        if (content.type === "toolCall") {
          const tracked = parseToolArgs(content.name, content.arguments);
          pendingToolCalls.set(content.id, tracked);
          yield {
            type: "timeline",
            provider,
            item: {
              type: "tool_call",
              callId: content.id,
              name: tracked.toolName,
              status: "running",
              detail: mapToolDetail(tracked, null),
              error: null,
            },
          };
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const tracked =
        pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
      pendingToolCalls.delete(message.toolCallId);
      const result = parseToolResult({ content: message.content });
      const detail = mapToolDetail(tracked, result);
      yield {
        type: "timeline",
        provider,
        item: toToolResultTimelineItem({
          callId: message.toolCallId,
          name: tracked.toolName,
          isError: Boolean(message.isError),
          detail,
          errorText: extractTextFromToolResult(result) ?? "Tool call failed",
        }),
      };
      continue;
    }

    if (message.role === "bashExecution") {
      const callId = `pi-bash-${message.timestamp}`;
      const detail: ToolCallDetail = {
        type: "shell",
        command: message.command,
        output: message.output,
        exitCode: message.exitCode ?? null,
      };
      yield {
        type: "timeline",
        provider,
        item: {
          type: "tool_call",
          callId,
          name: "bash",
          status: message.cancelled ? "canceled" : "completed",
          detail,
          error: null,
        },
      };
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
