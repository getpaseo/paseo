import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { mapClaudeRunningToolCall } from "./tool-call-mapper.js";
import { buildToolCallDisplayModel } from "../../../../shared/tool-call-display.js";

import type { AgentMetadata, AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";

type ClaudeContentChunk = { type: string; [key: string]: unknown };

type SubAgentActionEntry = {
  index: number;
  toolName: string;
  summary?: string;
};

type SubAgentActivityState = {
  subAgentType?: string;
  description?: string;
  actions: SubAgentActionEntry[];
  actionKeys: string[];
  nextActionIndex: number;
  actionIndexByKey: Map<string, number>;
};

type SubAgentActionCandidate = {
  key: string;
  toolName: string;
  input: unknown;
};

const MAX_SUB_AGENT_LOG_ENTRIES = 200;
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

  constructor(input: {
    getToolInput: (toolUseId: string) => AgentMetadata | null | undefined;
  }) {
    this.getToolInput = input.getToolInput;
  }

  handleMessage(message: SDKMessage, parentToolUseId: string): AgentStreamEvent[] {
    const state =
      this.activeSidechains.get(parentToolUseId) ??
      ({
        actions: [],
        actionKeys: [],
        nextActionIndex: 1,
        actionIndexByKey: new Map<string, number>(),
      } satisfies SubAgentActivityState);
    this.activeSidechains.set(parentToolUseId, state);

    const contextUpdated = this.updateSubAgentContextFromTaskInput(state, parentToolUseId);
    const actionCandidates = this.extractSubAgentActionCandidates(message);
    let actionUpdated = false;
    for (const action of actionCandidates) {
      if (this.appendSubAgentAction(state, action)) {
        actionUpdated = true;
      }
    }

    if (!contextUpdated && !actionUpdated) {
      return [];
    }

    const toolCall = mapClaudeRunningToolCall({
      name: "Task",
      callId: parentToolUseId,
      input: null,
      output: null,
    });
    if (!toolCall) {
      return [];
    }

    const detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"] = {
      type: "sub_agent",
      ...(state.subAgentType ? { subAgentType: state.subAgentType } : {}),
      ...(state.description ? { description: state.description } : {}),
      log: state.actions
        .map((action) =>
          action.summary ? `[${action.toolName}] ${action.summary}` : `[${action.toolName}]`,
        )
        .join("\n"),
      actions: state.actions.map((action) => ({
        index: action.index,
        toolName: action.toolName,
        ...(action.summary ? { summary: action.summary } : {}),
      })),
    };

    return [
      {
        type: "timeline",
        item: {
          ...toolCall,
          detail,
        },
        provider: "claude",
      },
    ];
  }

  delete(toolUseId: string): void {
    this.activeSidechains.delete(toolUseId);
  }

  clear(): void {
    this.activeSidechains.clear();
  }

  private updateSubAgentContextFromTaskInput(
    state: SubAgentActivityState,
    parentToolUseId: string,
  ): boolean {
    const taskInput = this.getToolInput(parentToolUseId);
    const nextSubAgentType = this.normalizeSubAgentText(taskInput?.subagent_type);
    const nextDescription = this.normalizeSubAgentText(taskInput?.description);

    let changed = false;
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

  private extractSubAgentActionCandidates(message: SDKMessage): SubAgentActionCandidate[] {
    if (message.type === "assistant") {
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

    if (message.type === "stream_event") {
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
      return [
        {
          key,
          toolName: block.name,
          input: block.input ?? null,
        },
      ];
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

  private appendSubAgentAction(
    state: SubAgentActivityState,
    candidate: SubAgentActionCandidate,
  ): boolean {
    const normalizedToolName = readTrimmedString(candidate.toolName);
    if (!normalizedToolName) {
      return false;
    }

    const summary = this.deriveSubAgentActionSummary(normalizedToolName, candidate.input);
    const existingIndex = state.actionIndexByKey.get(candidate.key);

    if (existingIndex !== undefined) {
      const existing = state.actions[existingIndex];
      if (!existing) {
        return false;
      }
      const nextSummary = existing.summary ?? summary;
      if (existing.toolName === normalizedToolName && existing.summary === nextSummary) {
        return false;
      }
      state.actions[existingIndex] = {
        ...existing,
        toolName: normalizedToolName,
        ...(nextSummary ? { summary: nextSummary } : {}),
      };
      return true;
    }

    state.actions.push({
      index: state.nextActionIndex,
      toolName: normalizedToolName,
      ...(summary ? { summary } : {}),
    });
    state.nextActionIndex += 1;
    state.actionKeys.push(candidate.key);
    this.trimSubAgentTail(state);
    this.rebuildSubAgentActionIndex(state);
    return true;
  }

  private trimSubAgentTail(state: SubAgentActivityState): void {
    while (state.actions.length > MAX_SUB_AGENT_LOG_ENTRIES) {
      state.actions.shift();
      state.actionKeys.shift();
    }
  }

  private rebuildSubAgentActionIndex(state: SubAgentActivityState): void {
    state.actionIndexByKey.clear();
    for (let index = 0; index < state.actionKeys.length; index += 1) {
      const key = state.actionKeys[index];
      if (key) {
        state.actionIndexByKey.set(key, index);
      }
    }
  }

  private deriveSubAgentActionSummary(toolName: string, input: unknown): string | undefined {
    const runningToolCall = mapClaudeRunningToolCall({
      name: toolName,
      callId: `sub-agent-summary-${toolName}`,
      input,
      output: null,
    });
    if (!runningToolCall) {
      return undefined;
    }
    const display = buildToolCallDisplayModel({
      name: runningToolCall.name,
      status: runningToolCall.status,
      error: runningToolCall.error,
      detail: runningToolCall.detail,
      metadata: runningToolCall.metadata,
    });
    return this.normalizeSubAgentText(display.summary);
  }
}
