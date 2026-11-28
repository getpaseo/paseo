import type { SDKMessage, SessionCronSummary } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackgroundWorkInput } from "../../background-work/index.js";
import { parseClaudeCodeVersion } from "./model-manifest.js";
import { toBackgroundWorkInputs, type ClaudeBackgroundTask } from "./background-work.js";

const SESSION_CRON_TOOLS = new Set(["CronCreate", "CronDelete", "ScheduleWakeup"]);

/** Process-local background ownership. Completion delivery can follow an empty roster. */
export class ClaudeRuntimeSafety {
  private inventoryState: "unknown" | "supported" | "retired" = "unknown";
  // Background work starts inside a turn, and init only arrives with a turn. A process that
  // has neither been sent a prompt nor reported init (a resumed chat that only answered
  // control requests) owns no background work.
  private turnSeen = false;
  /** Whether this process ever announced a turn of its own via system/init. */
  private initSeen = false;
  private liveTasks: readonly ClaudeBackgroundTask[] = [];
  private published: AgentBackgroundWorkInput[] | undefined;
  private readonly awaitingNotifications = new Set<string>();
  private readonly monitorTools = new Set<string>();
  private readonly toolInputs = new Map<string, { description?: string; command?: string }>();
  private readonly taskTools = new Map<string, string>();
  // Session-only crons and wakeups live in the process and die with it. Only the Stop hook
  // lists them, and Claude runs it only for turns that complete. A cron tool call makes the
  // count unknown until the next Stop, so an interrupted or failed turn keeps the runtime.
  private sessionCrons = 0;
  private sessionCronsUnknown = false;
  // One-shot wakeups (ScheduleWakeup) start a turn by themselves; recurring crons never settle.
  private oneShotWakeups = 0;

  reset(): void {
    this.sessionCrons = 0;
    this.oneShotWakeups = 0;
    this.sessionCronsUnknown = false;
    this.inventoryState = "unknown";
    this.turnSeen = false;
    this.initSeen = false;
    this.liveTasks = [];
    this.published = undefined;
    this.awaitingNotifications.clear();
    this.monitorTools.clear();
    this.toolInputs.clear();
    this.taskTools.clear();
  }

  retire(): void {
    this.reset();
    this.inventoryState = "retired";
  }

  /** Called before a prompt is written to this process. */
  notePromptSent(): void {
    this.turnSeen = true;
  }

  /**
   * Called when a cancel withdrew every prompt sent to a process that never started a turn.
   * Restores the untouched stoppable state unless the process already announced an init.
   */
  notePromptWithdrawn(): void {
    if (this.initSeen) return;
    this.turnSeen = false;
  }

  /** Called with the session crons of each main-thread Stop hook. Older CLIs omit them. */
  observeStop(sessionCrons: readonly SessionCronSummary[] | undefined): void {
    if (this.inventoryState === "retired") return;
    this.sessionCronsUnknown = false;
    if (sessionCrons) {
      this.sessionCrons = sessionCrons.length;
      this.oneShotWakeups = sessionCrons.filter((cron) => !cron.recurring).length;
    }
  }

  /**
   * True while a live background task or an undelivered task notification will start a turn,
   * or a one-shot wakeup is scheduled. Recurring crons are excluded: they never settle.
   */
  hasPendingWakeup(): boolean {
    return (
      this.liveTasks.length > 0 || this.awaitingNotifications.size > 0 || this.oneShotWakeups > 0
    );
  }

  /** Returns a full replacement only when the visible inventory changes. */
  observe(message: SDKMessage): AgentBackgroundWorkInput[] | undefined {
    if (this.inventoryState === "retired") return undefined;
    const changed = this.observeTools(message);
    const systemChanged = message.type === "system" ? this.observeSystem(message) : false;
    if ((!changed && !systemChanged) || this.inventoryState !== "supported") return undefined;
    const items = this.buildInventory();
    if (this.published && sameInventory(this.published, items)) return undefined;
    this.published = items;
    return items;
  }

  private observeTools(message: SDKMessage): boolean {
    if (message.type === "assistant") {
      let relevant = false;
      for (const block of message.message.content) {
        if (block.type === "tool_use" && SESSION_CRON_TOOLS.has(block.name))
          this.sessionCronsUnknown = true;
        if (block.type === "tool_use" && (block.name === "Monitor" || block.name === "Bash")) {
          if (block.name === "Monitor") relevant = this.observeMonitor(block.id) || relevant;
          relevant = this.observeInput(block.id, block.input) || relevant;
        }
      }
      return relevant;
    }
    if (message.type === "stream_event" && message.event.type === "content_block_start") {
      const block = message.event.content_block;
      if (block.type === "tool_use" && block.name === "Monitor")
        return this.observeMonitor(block.id);
    }
    return false;
  }

  private observeInput(id: string, value: unknown): boolean {
    const input = value as Record<string, unknown> | null;
    const description = typeof input?.description === "string" ? input.description.trim() : "";
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    const previous = this.toolInputs.get(id);
    if (description === (previous?.description ?? "") && command === (previous?.command ?? ""))
      return false;
    this.toolInputs.set(id, {
      ...(description ? { description } : {}),
      ...(command ? { command } : {}),
    });
    return this.liveTasks.some((task) => this.taskTools.get(task.task_id) === id);
  }

  private observeMonitor(id: string): boolean {
    if (this.monitorTools.has(id)) return false;
    this.monitorTools.add(id);
    return this.liveTasks.some((task) => this.taskTools.get(task.task_id) === id);
  }

  private observeSystem(message: Extract<SDKMessage, { type: "system" }>): boolean {
    if (message.subtype === "task_started" && message.tool_use_id) {
      const previous = this.taskTools.get(message.task_id);
      this.taskTools.set(message.task_id, message.tool_use_id);
      return (
        previous !== message.tool_use_id &&
        (this.monitorTools.has(message.tool_use_id) ||
          this.toolInputs.has(message.tool_use_id) ||
          (previous !== undefined &&
            (this.monitorTools.has(previous) || this.toolInputs.has(previous)))) &&
        this.liveTasks.some((task) => task.task_id === message.task_id)
      );
    }
    if (message.subtype === "init") {
      this.turnSeen = true;
      this.initSeen = true;
      const version = parseClaudeCodeVersion(message.claude_code_version ?? "");
      if (
        version &&
        (version[0] > 2 ||
          (version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 292))))
      ) {
        const changed = this.inventoryState !== "supported";
        this.inventoryState = "supported";
        return changed;
      }
    }
    if (message.subtype === "background_tasks_changed") {
      this.inventoryState = "supported";
      this.liveTasks = message.tasks;
      for (const task of this.liveTasks) this.awaitingNotifications.add(task.task_id);
      return true;
    }
    if (message.subtype === "task_notification") this.awaitingNotifications.delete(message.task_id);
    return false;
  }

  canStopRuntime(): boolean {
    if (this.inventoryState === "unknown" && !this.turnSeen) return true;
    return (
      this.inventoryState === "supported" &&
      this.sessionCrons === 0 &&
      !this.sessionCronsUnknown &&
      this.liveTasks.length === 0 &&
      this.awaitingNotifications.size === 0
    );
  }

  canStop(id: string): boolean {
    return this.buildInventory().some((item) => item.id === id && item.canStop);
  }

  isCurrentInventory(items: AgentBackgroundWorkInput[]): boolean {
    return this.inventoryState === "supported" && this.published === items;
  }

  private buildInventory(): AgentBackgroundWorkInput[] {
    return toBackgroundWorkInputs(this.liveTasks).map((item) => {
      const tool = this.taskTools.get(item.id) ?? "";
      if (this.monitorTools.has(tool)) item.kind = "monitor";
      const input = this.toolInputs.get(tool);
      if (input?.description) item.description = input.description;
      if (input?.command) item.command = input.command;
      return item;
    });
  }
}

function sameInventory(
  left: readonly AgentBackgroundWorkInput[],
  right: readonly AgentBackgroundWorkInput[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index].id &&
        item.kind === right[index].kind &&
        item.description === right[index].description &&
        item.command === right[index].command &&
        item.canStop === right[index].canStop,
    )
  );
}
