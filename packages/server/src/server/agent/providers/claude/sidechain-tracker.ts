import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "./tool-call-mapper.js";
import {
  isClaudeSubagentHandbackToolName,
  readClaudeSubagentHandback,
} from "./subagent-handback.js";

import type { AgentMetadata, AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";

interface ClaudeContentChunk {
  type: string;
  [key: string]: unknown;
}

type ClaudeToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

interface SubAgentChildCall {
  toolName: string;
  input: unknown;
}

interface SubAgentActivityState {
  name?: string;
  subAgentType?: string;
  description?: string;
  /** The child's tool calls awaiting results, which carry no input of their own. */
  runningCalls: Map<string, SubAgentChildCall>;
  completedActionKeys: Set<string>;
}

interface SubAgentActionCandidate {
  key: string;
  toolName: string;
  input: unknown;
}

const MAX_SUB_AGENT_SUMMARY_CHARS = 160;

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isClaudeContentChunk(value: unknown): value is ClaudeContentChunk {
  return Boolean(
    value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string",
  );
}

export class ClaudeSidechainTracker {
  private readonly activeSidechains = new Map<string, SubAgentActivityState>();
  private readonly getToolInput: (toolUseId: string) => AgentMetadata | null | undefined;
  private readonly isDescriptorOwnedElsewhere: () => boolean;
  private readonly needsSyntheticParentToolCard: (toolUseId: string) => boolean;
  private readonly getSettledParentToolCall: (toolUseId: string) => ClaudeToolCallItem | undefined;

  constructor(input: {
    getToolInput: (toolUseId: string) => AgentMetadata | null | undefined;
    /**
     * When the provider learns subagent identity and status declaratively, this tracker stops
     * emitting descriptor upserts and maps frames to timeline items only. Two owners writing the
     * same descriptor from different evidence is how the live and replay paths drifted apart.
     */
    isDescriptorOwnedElsewhere?: () => boolean;
    needsSyntheticParentToolCard?: (toolUseId: string) => boolean;
    /**
     * The parent's tool call once Claude has answered it. A background child streams its frames
     * after that answer, so its card keeps the settled status and output.
     */
    getSettledParentToolCall?: (toolUseId: string) => ClaudeToolCallItem | undefined;
  }) {
    this.getToolInput = input.getToolInput;
    this.isDescriptorOwnedElsewhere = input.isDescriptorOwnedElsewhere ?? (() => false);
    this.needsSyntheticParentToolCard = input.needsSyntheticParentToolCard ?? (() => true);
    this.getSettledParentToolCall = input.getSettledParentToolCall ?? (() => undefined);
  }

  handleMessage(message: SDKMessage, parentToolUseId: string): AgentStreamEvent[] {
    const existingState = this.activeSidechains.get(parentToolUseId);
    const state =
      existingState ??
      ({
        runningCalls: new Map<string, SubAgentChildCall>(),
        completedActionKeys: new Set<string>(),
      } satisfies SubAgentActivityState);
    this.activeSidechains.set(parentToolUseId, state);

    // The parent card is a launch marker: it changes only when the child is first seen or the
    // task input names it differently, never with the child's activity.
    const cardUpdated =
      this.updateSubAgentContextFromTaskInput(state, parentToolUseId) || !existingState;
    const actionCandidates = this.extractSubAgentActionCandidates(message);
    const childTimelineItems = [
      ...this.extractSubAgentTimelineItems(message, state),
      ...this.extractSubAgentToolResults(message, state),
    ];
    for (const action of actionCandidates) {
      if (state.completedActionKeys.has(action.key)) continue;
      if (this.trackChildCall(state, action)) {
        const toolCall = mapClaudeRunningToolCall({
          name: action.toolName,
          callId: action.key,
          input: action.input,
          output: null,
        });
        if (toolCall) {
          childTimelineItems.push(toolCall);
        }
      }
    }

    if (!cardUpdated && childTimelineItems.length === 0) {
      return [];
    }

    const toolCall =
      this.getSettledParentToolCall(parentToolUseId) ??
      mapClaudeRunningToolCall({
        name: "Task",
        callId: parentToolUseId,
        input: null,
        output: null,
      });
    if (!toolCall) {
      return [];
    }

    const detail: ClaudeToolCallItem["detail"] = {
      type: "sub_agent",
      ...(state.subAgentType ? { subAgentType: state.subAgentType } : {}),
      ...(state.description ? { description: state.description } : {}),
      // COMPAT(subagent-log): remove after 2027-04-30.
      log: "",
      actions: [],
    };

    const descriptorEvents: AgentStreamEvent[] = this.isDescriptorOwnedElsewhere()
      ? []
      : [
          {
            type: "provider_subagent",
            provider: "claude",
            event: {
              type: "upsert",
              id: parentToolUseId,
              title: state.name ?? state.subAgentType ?? "Claude subagent",
              description: state.description ?? null,
              status: "running",
              toolCallId: parentToolUseId,
            },
          },
        ];

    const parentCard: AgentStreamEvent[] =
      cardUpdated && this.needsSyntheticParentToolCard(parentToolUseId)
        ? [
            {
              type: "timeline",
              item: {
                ...toolCall,
                detail,
              },
              provider: "claude",
            },
          ]
        : [];

    return [
      ...descriptorEvents,
      ...childTimelineItems.map(
        (item): AgentStreamEvent => ({
          type: "provider_subagent",
          provider: "claude",
          event: { type: "timeline", id: parentToolUseId, item },
        }),
      ),
      ...parentCard,
    ];
  }

  finishAll(status: "completed" | "failed" | "canceled"): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    if (this.isDescriptorOwnedElsewhere()) {
      // The task protocol owns child completion; the parent finishing does not end its children.
      return events;
    }
    for (const [id, state] of this.activeSidechains) {
      events.push({
        type: "provider_subagent",
        provider: "claude",
        event: {
          type: "upsert",
          id,
          title: state.name ?? state.subAgentType ?? "Claude subagent",
          description: state.description ?? null,
          status,
          toolCallId: id,
        },
      });
    }
    this.activeSidechains.clear();
    return events;
  }

  finish(id: string, status: "completed" | "failed" | "canceled"): AgentStreamEvent[] {
    const state = this.activeSidechains.get(id);
    if (!state) return [];
    this.activeSidechains.delete(id);
    if (this.isDescriptorOwnedElsewhere()) return [];
    return [
      {
        type: "provider_subagent",
        provider: "claude",
        event: {
          type: "upsert",
          id,
          title: state.name ?? state.subAgentType ?? "Claude subagent",
          description: state.description ?? null,
          status,
          toolCallId: id,
        },
      },
    ];
  }

  delete(toolUseId: string): void {
    this.activeSidechains.delete(toolUseId);
  }

  clear(): void {
    this.activeSidechains.clear();
  }

  private extractSubAgentTimelineItems(
    message: SDKMessage,
    state: SubAgentActivityState,
  ): AgentTimelineItem[] {
    if (message.type !== "assistant" || !Array.isArray(message.message?.content)) {
      return [];
    }
    const messageId = readTrimmedString(message.message.id);
    const items: AgentTimelineItem[] = [];
    for (const block of message.message.content) {
      if (!isClaudeContentChunk(block)) continue;
      if (block.type === "text") {
        const text = readTrimmedString(block.text);
        if (text) {
          items.push({
            type: "assistant_message",
            text,
            ...(messageId ? { messageId } : {}),
          });
        }
      } else if (block.type === "thinking") {
        const text = readTrimmedString(block.thinking);
        if (text) items.push({ type: "reasoning", text });
      } else {
        const handback = readClaudeSubagentHandback(block);
        if (!handback) continue;
        // The handback's result is only an acknowledgement, never a tool card.
        state.completedActionKeys.add(handback.callId);
        if (handback.report) {
          items.push({
            type: "assistant_message",
            text: handback.report,
            ...(messageId ? { messageId } : {}),
          });
        }
      }
    }
    return items;
  }

  private extractSubAgentToolResults(
    message: SDKMessage,
    state: SubAgentActivityState,
  ): AgentTimelineItem[] {
    const messageRecord = message as unknown as Record<string, unknown>;
    const messageContainer = messageRecord.message as Record<string, unknown> | undefined;
    const content = messageContainer?.content;
    if (!Array.isArray(content)) return [];

    const items: AgentTimelineItem[] = [];
    for (const block of content) {
      if (!isClaudeContentChunk(block) || !block.type.endsWith("tool_result")) continue;
      const callId = readTrimmedString(block.tool_use_id);
      if (!callId || state.completedActionKeys.has(callId)) continue;
      const action = state.runningCalls.get(callId);
      const toolName = action?.toolName ?? readTrimmedString(block.tool_name);
      if (!toolName) continue;
      const params = {
        name: toolName,
        callId,
        input: action?.input ?? null,
        output: block.content ?? null,
      };
      const toolCall = block.is_error
        ? mapClaudeFailedToolCall({ ...params, error: block })
        : mapClaudeCompletedToolCall(params);
      if (toolCall) {
        state.runningCalls.delete(callId);
        state.completedActionKeys.add(callId);
        items.push(toolCall);
      }
    }
    return items;
  }

  private updateSubAgentContextFromTaskInput(
    state: SubAgentActivityState,
    parentToolUseId: string,
  ): boolean {
    const taskInput = this.getToolInput(parentToolUseId);
    const nextName = this.normalizeSubAgentText(taskInput?.name);
    const nextSubAgentType = this.normalizeSubAgentText(taskInput?.subagent_type);
    const nextDescription = this.normalizeSubAgentText(taskInput?.description);

    let changed = false;
    if (nextName && nextName !== state.name) {
      state.name = nextName;
      changed = true;
    }
    if (nextSubAgentType && nextSubAgentType !== state.subAgentType) {
      state.subAgentType = nextSubAgentType;
      changed = true;
    }
    if (nextDescription && nextDescription !== state.description) {
      state.description = nextDescription;
      changed = true;
    }
    return changed;
  }

  private normalizeSubAgentText(value: unknown): string | undefined {
    const normalized = readTrimmedString(value)?.replace(/\s+/g, " ");
    if (!normalized) {
      return undefined;
    }
    if (normalized.length <= MAX_SUB_AGENT_SUMMARY_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, MAX_SUB_AGENT_SUMMARY_CHARS)}...`;
  }

  private extractAssistantMessageActions(
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): SubAgentActionCandidate[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const actions: SubAgentActionCandidate[] = [];
    for (const block of content) {
      if (
        !isClaudeContentChunk(block) ||
        !(
          block.type === "tool_use" ||
          block.type === "mcp_tool_use" ||
          block.type === "server_tool_use"
        ) ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const key = readTrimmedString(block.id) ?? `assistant:${block.name}:${actions.length}`;
      actions.push({
        key,
        toolName: block.name,
        input: block.input ?? null,
      });
    }
    return actions;
  }

  private extractStreamEventActions(
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): SubAgentActionCandidate[] {
    const event = message.event;
    if (event.type !== "content_block_start") {
      return [];
    }
    const block = isClaudeContentChunk(event.content_block) ? event.content_block : null;
    if (
      !block ||
      !(
        block.type === "tool_use" ||
        block.type === "mcp_tool_use" ||
        block.type === "server_tool_use"
      ) ||
      typeof block.name !== "string"
    ) {
      return [];
    }
    const key =
      readTrimmedString(block.id) ??
      `stream:${block.name}:${typeof event.index === "number" ? event.index : 0}`;
    // A streamed call starts with `{}` until its input arrives, so an empty input is not final.
    const input =
      block.input && typeof block.input === "object" && Object.keys(block.input).length > 0
        ? block.input
        : null;
    return [{ key, toolName: block.name, input }];
  }

  private extractSubAgentActionCandidates(message: SDKMessage): SubAgentActionCandidate[] {
    return this.extractToolActionCandidates(message).filter(
      (action) => !isClaudeSubagentHandbackToolName(action.toolName),
    );
  }

  private extractToolActionCandidates(message: SDKMessage): SubAgentActionCandidate[] {
    if (message.type === "assistant") {
      return this.extractAssistantMessageActions(message);
    }

    if (message.type === "stream_event") {
      return this.extractStreamEventActions(message);
    }

    if (message.type === "tool_progress") {
      const toolName = readTrimmedString(message.tool_name);
      if (!toolName) {
        return [];
      }
      const key = readTrimmedString(message.tool_use_id) ?? `progress:${toolName}`;
      return [{ key, toolName, input: null }];
    }

    return [];
  }

  /** Returns whether the call is new or has gained its input, so its running card changes. */
  private trackChildCall(
    state: SubAgentActivityState,
    candidate: SubAgentActionCandidate,
  ): boolean {
    const toolName = readTrimmedString(candidate.toolName);
    if (!toolName) {
      return false;
    }
    const existing = state.runningCalls.get(candidate.key);
    if (existing && (existing.input !== null || candidate.input === null)) {
      return false;
    }
    state.runningCalls.set(candidate.key, { toolName, input: candidate.input });
    return true;
  }
}
