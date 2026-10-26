import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

export type ClaudeBackgroundWorkState =
  | { kind: "none" }
  | { kind: "active"; liveTaskIds: string[]; sessionState: string | null }
  | { kind: "unknown"; reason: string };

/**
 * Tracks work that lives inside one Claude Code process and would die with it: background Bash
 * shells, Monitor watches, workflows and backgrounded subagents. Claude Code announces each of
 * them with `task_started` and settles it with `task_updated` or `task_notification`, and its
 * `session_state_changed` stays "running" while any of them is alive.
 *
 * The tracker is scoped to one process. Work announced by an earlier process died with it, so the
 * owner calls `reset()` whenever it starts a new one.
 */
export class ClaudeBackgroundWorkTracker {
  private readonly liveTaskIds = new Set<string>();
  private sessionState: string | null = null;
  private turnObserved = false;

  reset(): void {
    this.liveTaskIds.clear();
    this.sessionState = null;
    this.turnObserved = false;
  }

  /** A main-session turn ran on this process, so it may have started background work. */
  noteTurnStarted(): void {
    this.turnObserved = true;
  }

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    switch (message.subtype) {
      case "session_state_changed":
        this.sessionState = message.state;
        return;
      case "task_started":
        this.liveTaskIds.add(message.task_id);
        return;
      case "task_updated": {
        const status = message.patch?.status;
        if (status && TERMINAL_TASK_STATUSES.has(status)) {
          this.liveTaskIds.delete(message.task_id);
        } else if (status) {
          // pending, running and paused tasks still belong to this process.
          this.liveTaskIds.add(message.task_id);
        }
        return;
      }
      case "task_notification":
        this.liveTaskIds.delete(message.task_id);
        return;
      default:
        return;
    }
  }

  state(): ClaudeBackgroundWorkState {
    if (
      this.liveTaskIds.size > 0 ||
      this.sessionState === "running" ||
      this.sessionState === "requires_action"
    ) {
      return {
        kind: "active",
        liveTaskIds: [...this.liveTaskIds],
        sessionState: this.sessionState,
      };
    }
    if (this.turnObserved && this.sessionState === null) {
      // A turn ran but Claude never reported its session state, so idleness cannot be proven.
      return { kind: "unknown", reason: "Claude did not report session state after a turn" };
    }
    return { kind: "none" };
  }
}
