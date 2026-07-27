import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import type { SubagentObservation } from "./observation.js";

/**
 * Claude Code announces subagent lifecycle on the SDK stream. This reads those announcements
 * instead of reconstructing them from sidechain frames.
 *
 * Verified on the wire (Claude Code 2.1.220, Paseo's own query options):
 *
 *   task_started       task_id, tool_use_id, description, subagent_type, task_type
 *   task_updated       task_id, patch.status, patch.is_backgrounded
 *   task_notification  task_id, tool_use_id, status
 *
 * Only `task_started` carries `tool_use_id`, so the mapping from task id to the canonical
 * subagent id has to be remembered. That table is the only state here, and it is a lookup
 * rather than a state machine: nothing is inferred from message ordering.
 *
 * The table is session-scoped, because task ids are. It survives a turn ending — the one thing a
 * turn ending warrants is `cancelRunningForegroundTasks`, not forgetting the session.
 */

interface TaskStartedMessage {
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  skip_transcript?: boolean;
}

interface TaskUpdatedMessage {
  task_id: string;
  /**
   * `is_backgrounded` is declared on `SDKTaskUpdatedMessage["patch"]`: it flips when a foreground
   * task is backgrounded, which is the only signal that separates a child that dies with its turn
   * from one that was explicitly told to outlive it.
   */
  patch?: { status?: string; is_backgrounded?: boolean };
}

interface TaskNotificationMessage {
  task_id: string;
  tool_use_id?: string;
  status?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The descriptor has no paused or pending state, and neither is terminal, so both read as
 * running. `killed` is a cancellation, not a failure — the child was stopped, it did not error.
 */
function mapTaskStatus(status: string | undefined): ProviderSubagentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return undefined;
  }
}

export class ClaudeTaskProtocolSource {
  /** task_id -> canonical subagent id (the Task tool_use id). Populated by task_started. */
  private readonly subagentIdByTaskId = new Map<string, string>();
  /**
   * Every subagent id this source declared. It is the source's whole vocabulary: an id that is
   * not in here was either filtered at declaration or never announced, and this source has
   * nothing to say about it.
   */
  private readonly declaredIds = new Set<string>();
  /**
   * Declared subagents that were moved to the background. They outlive the turn that spawned
   * them, so a turn ending is not evidence that they stopped.
   */
  private readonly backgroundedIds = new Set<string>();
  /** Last status emitted per subagent, so a redundant announcement is not re-broadcast. */
  private readonly lastStatusById = new Map<string, ProviderSubagentStatus>();
  private sawTaskStarted = false;

  /**
   * True once this session has announced at least one task. Older Claude Code releases predate
   * the task protocol; callers use this to decide whether the legacy derivation still has work
   * to do, rather than assuming a version.
   */
  get isActive(): boolean {
    return this.sawTaskStarted;
  }

  observe(message: SDKMessage): SubagentObservation[] {
    if (message.type !== "system") return [];
    switch (message.subtype) {
      case "task_started":
        return this.observeTaskStarted(message as unknown as TaskStartedMessage);
      case "task_updated":
        return this.observeTaskUpdated(message as unknown as TaskUpdatedMessage);
      case "task_notification":
        return this.observeTaskNotification(message as unknown as TaskNotificationMessage);
      default:
        return [];
    }
  }

  /**
   * Forget the session.
   *
   * Task ids are session-scoped and outlive any single turn, so this belongs to session teardown
   * alone. Clearing it when a turn ends would drop the routing table while its tasks were still
   * live — see `cancelRunningForegroundTasks`, which is what a turn ending actually warrants.
   */
  reset(): void {
    this.subagentIdByTaskId.clear();
    this.declaredIds.clear();
    this.backgroundedIds.clear();
    this.lastStatusById.clear();
    this.sawTaskStarted = false;
  }

  /**
   * Terminalize the subagents that a canceled turn was running.
   *
   * Cancellation is a fact about the turn, not about the task table: the session, and every id in
   * it, outlives the turn. So this reports statuses and leaves the routing intact — that is what
   * lets a child which settles after the interrupt still find its descriptor, and what keeps a
   * later `task_notification` free to correct this guess.
   *
   * Backgrounded children are skipped. Being backgrounded is precisely the declaration that they
   * outlive the turn; everything else was running in the foreground and died with it.
   */
  cancelRunningForegroundTasks(): SubagentObservation[] {
    const observations: SubagentObservation[] = [];
    for (const id of this.declaredIds) {
      if (this.backgroundedIds.has(id)) continue;
      if (this.lastStatusById.get(id) !== "running") continue;
      this.lastStatusById.set(id, "canceled");
      observations.push({ kind: "status", id, status: "canceled" });
    }
    return observations;
  }

  private observeTaskStarted(message: TaskStartedMessage): SubagentObservation[] {
    const id = readString(message.tool_use_id);
    // Tasks without a tool_use id are not Task-tool subagents (workflows, background chores),
    // and skip_transcript marks ambient housekeeping the transcript should not show. Filtering
    // on the announcement is exact; the sidechain frames carry no equivalent signal.
    if (!id || message.skip_transcript === true) return [];

    this.sawTaskStarted = true;
    this.subagentIdByTaskId.set(message.task_id, id);
    this.declaredIds.add(id);
    this.lastStatusById.set(id, "running");

    const title = readString(message.subagent_type);
    const description = readString(message.description);
    return [
      {
        kind: "declared",
        id,
        toolCallId: id,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      },
    ];
  }

  private observeTaskUpdated(message: TaskUpdatedMessage): SubagentObservation[] {
    const id = this.subagentIdByTaskId.get(message.task_id);
    const backgrounded = message.patch?.is_backgrounded;
    if (id && typeof backgrounded === "boolean") {
      if (backgrounded) this.backgroundedIds.add(id);
      else this.backgroundedIds.delete(id);
    }
    return this.observeStatus(message.task_id, undefined, message.patch?.status);
  }

  private observeTaskNotification(message: TaskNotificationMessage): SubagentObservation[] {
    return this.observeStatus(message.task_id, message.tool_use_id, message.status);
  }

  private observeStatus(
    taskId: string,
    toolUseId: string | undefined,
    rawStatus: string | undefined,
  ): SubagentObservation[] {
    const id = this.subagentIdByTaskId.get(taskId) ?? readString(toolUseId);
    if (!id) return [];
    const status = mapTaskStatus(rawStatus);
    if (!status || this.lastStatusById.get(id) === status) return [];
    this.lastStatusById.set(id, status);
    return [{ kind: "status", id, status }];
  }
}
