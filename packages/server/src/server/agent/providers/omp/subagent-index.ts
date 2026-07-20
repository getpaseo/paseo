import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpHistoryMapper } from "./message-history.js";
import type { OmpAgentMessage, OmpAgentSessionEvent } from "./rpc-types.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { formatOmpSubagentTitle } from "./subagent-title.js";
import type {
  OmpSubagentEventPayload,
  OmpSubagentLifecyclePayload,
  OmpSubagentProgressPayload,
} from "./rpc-types.js";

interface OmpSubagentState {
  title: string;
  description: string | null;
  resolvedModel: string | null;
  toolCallId: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  mapper: OmpHistoryMapper;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    state.status = mapLifecycleStatus(payload.status);
    return [this.upsert(payload.id, state.status, state)];
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) {
      state.resolvedModel = payload.progress.resolvedModel;
    }
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    state.status = mapProgressStatus(payload.progress.status);
    return [this.upsert(id, state.status, state)];
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    const messages = messagesFromSessionEvent(payload.event);
    return state.mapper.mapMessages(messages).flatMap((mapped) =>
      mapped.type === "timeline"
        ? [
            {
              type: "provider_subagent" as const,
              provider: "omp",
              event: {
                type: "timeline" as const,
                id: payload.id,
                item: mapped.item,
                ...(mapped.timestamp ? { timestamp: mapped.timestamp } : {}),
              },
            },
          ]
        : [],
    );
  }

  terminalizeRunning(parent: object): AgentStreamEvent[] {
    const states = this.statesByParent.get(parent);
    if (!states) {
      return [];
    }
    const events: AgentStreamEvent[] = [];
    for (const [id, state] of states) {
      if (state.status !== "running") {
        continue;
      }
      state.status = "canceled";
      events.push(this.upsert(id, state.status, state));
    }
    return events;
  }

  /**
   * True while any OMP-internal task child is still in-flight for this parent.
   * Used to keep the Paseo turn non-idle after parent `agent_end` while tasks run.
   */
  hasRunning(parent: object): boolean {
    const states = this.statesByParent.get(parent);
    if (!states) {
      return false;
    }
    for (const state of states.values()) {
      if (state.status === "running") {
        return true;
      }
    }
    return false;
  }

  /**
   * Merge a `get_subagents` snapshot into local state so missed event frames
   * do not leave idle detection blind.
   */
  reconcileSnapshots(
    parent: object,
    snapshots: ReadonlyArray<{
      id: string;
      agent: string;
      description?: string;
      status: "pending" | "running" | "completed" | "failed" | "aborted";
      parentToolCallId?: string;
    }>,
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    for (const snapshot of snapshots) {
      const state = this.stateFor(parent, snapshot.id, snapshot.agent);
      state.title = snapshot.agent || state.title;
      state.description = snapshot.description ?? state.description;
      state.toolCallId = snapshot.parentToolCallId ?? state.toolCallId;
      state.status = mapSnapshotStatus(snapshot.status);
      events.push(this.upsert(snapshot.id, state.status, state));
    }
    return events;
  }

  clear(parent: object): void {
    this.statesByParent.delete(parent);
  }

  private stateFor(parent: object, id: string, title: string): OmpSubagentState {
    const states = this.statesByParent.get(parent) ?? new Map<string, OmpSubagentState>();
    const existing = states.get(id);
    if (existing) return existing;
    const state: OmpSubagentState = {
      title,
      description: null,
      resolvedModel: null,
      toolCallId: null,
      status: "running",
      mapper: new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS),
    };
    states.set(id, state);
    this.statesByParent.set(parent, states);
    return state;
  }

  private upsert(
    id: string,
    status: "running" | "completed" | "failed" | "canceled",
    state: OmpSubagentState,
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: "omp",
      event: {
        type: "upsert",
        id,
        title: formatOmpSubagentTitle(state.title, state.resolvedModel),
        description: state.description,
        status,
        toolCallId: state.toolCallId,
      },
    };
  }
}

function messagesFromSessionEvent(event: OmpAgentSessionEvent): OmpAgentMessage[] {
  if (event.type === "message_end") return [event.message];
  return [];
}

function mapLifecycleStatus(
  status: OmpSubagentLifecyclePayload["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "started") return "running";
  return status === "aborted" ? "canceled" : status;
}

function mapProgressStatus(
  status: OmpSubagentProgressPayload["progress"]["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}

function mapSnapshotStatus(
  status: "pending" | "running" | "completed" | "failed" | "aborted",
): "running" | "completed" | "failed" | "canceled" {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}
