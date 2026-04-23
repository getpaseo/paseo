export type SessionUpdate =
  | UserMessageChunk
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate
  | Plan
  | AvailableCommandsUpdate
  | CurrentModeUpdate;

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

type TextMessageType = "user" | "agent" | "thought";

export interface UserMessageChunk {
  kind: "user_message_chunk";
  content: {
    type: "text";
    text: string;
  };
}

export interface AgentMessageChunk {
  kind: "agent_message_chunk";
  content: {
    type: "text";
    text: string;
  };
}

export interface AgentThoughtChunk {
  kind: "agent_thought_chunk";
  content: {
    type: "text";
    text: string;
  };
}

export interface ToolCall {
  kind: "tool_call";
  toolCallId: string;
  title: string;
  status?: ToolCallStatus;
  toolKind?: ToolKind;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  content?: unknown[];
  locations?: unknown[];
}

export interface ToolCallUpdate {
  kind: "tool_call_update";
  toolCallId: string;
  title?: string | null;
  status?: ToolCallStatus | null;
  toolKind?: ToolKind | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  content?: unknown[] | null;
  locations?: unknown[] | null;
}

export interface Plan {
  kind: "plan";
  entries: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low";
  }>;
}

export interface AvailableCommandsUpdate {
  kind: "available_commands_update";
  availableCommands: Array<{
    name: string;
    description: string;
  }>;
}

export interface CurrentModeUpdate {
  kind: "current_mode_update";
  currentModeId: string;
}

export interface AgentActivity {
  timestamp: Date;
  update: SessionUpdate;
}

export interface GroupedTextMessage {
  kind: "grouped_text";
  messageType: TextMessageType;
  text: string;
  startTimestamp: Date;
  endTimestamp: Date;
}

export interface MergedToolCall {
  kind: "merged_tool_call";
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  toolKind?: ToolKind;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  content?: unknown[];
  locations?: unknown[];
  startTimestamp: Date;
  endTimestamp: Date;
}

export type GroupedActivity = GroupedTextMessage | MergedToolCall | AgentActivity;

type TextGroup = {
  messageType: TextMessageType;
  chunks: string[];
  startTimestamp: Date;
  endTimestamp: Date;
};

type ToolCallAccumulator = Omit<MergedToolCall, "kind"> & {
  insertIndex: number;
};

function getMessageType(
  update: UserMessageChunk | AgentMessageChunk | AgentThoughtChunk,
): TextMessageType {
  switch (update.kind) {
    case "user_message_chunk":
      return "user";
    case "agent_message_chunk":
      return "agent";
    case "agent_thought_chunk":
      return "thought";
  }
}

function isTextChunk(
  update: SessionUpdate,
): update is UserMessageChunk | AgentMessageChunk | AgentThoughtChunk {
  return (
    update.kind === "user_message_chunk" ||
    update.kind === "agent_message_chunk" ||
    update.kind === "agent_thought_chunk"
  );
}

function isGroupedActivity(item: GroupedActivity | null): item is GroupedActivity {
  return item !== null;
}

function toMergedToolCall(toolCall: ToolCallAccumulator): MergedToolCall {
  return {
    kind: "merged_tool_call",
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    status: toolCall.status,
    toolKind: toolCall.toolKind,
    input: toolCall.input,
    output: toolCall.output,
    content: toolCall.content,
    locations: toolCall.locations,
    startTimestamp: toolCall.startTimestamp,
    endTimestamp: toolCall.endTimestamp,
  };
}

export function groupActivities(activities: AgentActivity[]): GroupedActivity[] {
  const result: Array<GroupedActivity | null> = [];
  const toolCallsById = new Map<string, ToolCallAccumulator>();
  let currentTextGroup: TextGroup | null = null;

  function flushTextGroup() {
    if (!currentTextGroup) {
      return;
    }

    result.push({
      kind: "grouped_text",
      messageType: currentTextGroup.messageType,
      text: currentTextGroup.chunks.join(""),
      startTimestamp: currentTextGroup.startTimestamp,
      endTimestamp: currentTextGroup.endTimestamp,
    });
    currentTextGroup = null;
  }

  for (const activity of activities) {
    const update = activity.update;

    if (isTextChunk(update)) {
      const messageType = getMessageType(update);
      const text = update.content.text;

      if (currentTextGroup && currentTextGroup.messageType === messageType) {
        currentTextGroup.chunks.push(text);
        currentTextGroup.endTimestamp = activity.timestamp;
      } else {
        flushTextGroup();

        currentTextGroup = {
          messageType,
          chunks: [text],
          startTimestamp: activity.timestamp,
          endTimestamp: activity.timestamp,
        };
      }
    } else if (update.kind === "tool_call" || update.kind === "tool_call_update") {
      flushTextGroup();

      const toolCallId = update.toolCallId;
      const existing = toolCallsById.get(toolCallId);

      if (update.kind === "tool_call") {
        if (!existing) {
          const insertIndex = result.length;
          result.push(null);

          toolCallsById.set(toolCallId, {
            toolCallId,
            title: update.title,
            status: update.status || "pending",
            toolKind: update.toolKind,
            input: update.input,
            output: update.output,
            content: update.content,
            locations: update.locations,
            startTimestamp: activity.timestamp,
            endTimestamp: activity.timestamp,
            insertIndex,
          });
        } else {
          existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.toolKind) existing.toolKind = update.toolKind;
          if (update.input) existing.input = update.input;
          if (update.output) existing.output = update.output;
          if (update.content) existing.content = update.content;
          if (update.locations) existing.locations = update.locations;
          existing.endTimestamp = activity.timestamp;
        }
      } else {
        if (existing) {
          if (update.title) existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.toolKind) existing.toolKind = update.toolKind;
          if (update.input) existing.input = { ...existing.input, ...update.input };
          if (update.output) existing.output = { ...existing.output, ...update.output };
          if (update.content) existing.content = update.content;
          if (update.locations) existing.locations = update.locations;
          existing.endTimestamp = activity.timestamp;
        } else {
          const insertIndex = result.length;
          result.push(null);

          toolCallsById.set(toolCallId, {
            toolCallId,
            title: update.title || "Tool Call",
            status: update.status || "pending",
            toolKind: update.toolKind || undefined,
            input: update.input,
            output: update.output,
            content: update.content || undefined,
            locations: update.locations || undefined,
            startTimestamp: activity.timestamp,
            endTimestamp: activity.timestamp,
            insertIndex,
          });
        }
      }
    } else {
      flushTextGroup();
      result.push(activity);
    }
  }

  flushTextGroup();

  for (const toolCall of toolCallsById.values()) {
    result[toolCall.insertIndex] = toMergedToolCall(toolCall);
  }

  return result.filter(isGroupedActivity);
}
