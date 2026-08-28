/**
 * Adapts one daemon connection's live agent state (`SessionState.agents` /
 * `SessionState.agentTasks`) into the `FleetAgentInput[]` shape `selectFleetSnapshot` consumes.
 * Pure and synchronous: no React, no native imports, no wall-clock reads.
 */

import type { Agent } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import type { FleetAgentInput, FleetPendingPermission } from "./fleet-snapshot";

const SHORT_AGENT_ID_LENGTH = 8;

function pendingPermissionInput(agent: Agent): FleetPendingPermission | undefined {
  const request = agent.pendingPermissions[0];
  if (request === undefined) {
    return undefined;
  }
  const detailSource =
    request.description ??
    (request.input !== undefined ? JSON.stringify(request.input) : undefined);
  return {
    toolName: request.title ?? request.name,
    detail: detailSource !== undefined ? (detailSource.split("\n")[0] ?? "") : undefined,
    sinceMs: (agent.attentionTimestamp ?? agent.lastActivityAt).getTime(),
  };
}

function needsAttentionSinceMs(agent: Agent): number | undefined {
  if (agent.requiresAttention !== true || agent.attentionReason === "finished") {
    return undefined;
  }
  return (agent.attentionTimestamp ?? agent.lastActivityAt).getTime();
}

function runningSinceMs(agent: Agent): number | undefined {
  if (agent.status !== "running") {
    return undefined;
  }
  const startedAt = agent.activeTurn?.startedAt ?? agent.lastUserMessageAt ?? agent.updatedAt;
  return startedAt.getTime();
}

function errorSinceMs(agent: Agent): number | undefined {
  if (agent.status !== "error") {
    return undefined;
  }
  return (agent.attentionTimestamp ?? agent.lastActivityAt ?? agent.updatedAt).getTime();
}

interface TaskProgress {
  phase: string | undefined;
  todoDone: number;
  todoTotal: number;
}

function taskProgress(tasks: readonly TodoEntry[]): TaskProgress {
  const todoDone = tasks.filter((task) => task.completed || task.status === "completed").length;
  const inProgress = tasks.find((task) => task.status === "in_progress");
  return {
    phase: inProgress?.activeForm ?? inProgress?.text,
    todoDone,
    todoTotal: tasks.length,
  };
}

function toFleetAgentInput(agent: Agent, tasks: readonly TodoEntry[] | undefined): FleetAgentInput {
  const progress = tasks !== undefined ? taskProgress(tasks) : undefined;
  return {
    agentId: agent.id,
    title: agent.title ?? `Agent ${agent.id.slice(0, SHORT_AGENT_ID_LENGTH)}`,
    running: agent.status === "running",
    error: agent.status === "error",
    pendingPermission: pendingPermissionInput(agent),
    needsAttentionSinceMs: needsAttentionSinceMs(agent),
    runningSinceMs: runningSinceMs(agent),
    errorSinceMs: errorSinceMs(agent),
    phase: progress?.phase,
    todoDone: progress?.todoDone,
    todoTotal: progress?.todoTotal,
  };
}

/**
 * Excludes archived agents and agents outside the fleet's active lifecycle (`closed`,
 * `initializing`). Order follows `agents` map iteration order.
 */
export function deriveFleetAgentInputs(
  agents: ReadonlyMap<string, Agent>,
  agentTasks: ReadonlyMap<string, TodoEntry[]>,
): readonly FleetAgentInput[] {
  const inputs: FleetAgentInput[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt != null || agent.status === "closed" || agent.status === "initializing") {
      continue;
    }
    inputs.push(toFleetAgentInput(agent, agentTasks.get(agent.id)));
  }
  return inputs;
}
