import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseClaudeCodeVersion } from "./model-manifest.js";

/** Process-local background ownership. Completion delivery can follow an empty roster. */
export class ClaudeRuntimeSafety {
  private supported = false;
  private liveTasks = new Set<string>();
  private readonly awaitingNotifications = new Set<string>();

  reset(): void {
    this.supported = false;
    this.liveTasks.clear();
    this.awaitingNotifications.clear();
  }

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    if (message.subtype === "init") {
      // 2.1.292 is a known roster-capable release. Older binaries can demonstrate
      // support by sending a roster; a fresh process starts with an empty roster.
      const version = parseClaudeCodeVersion(message.claude_code_version ?? "");
      if (
        version &&
        (version[0] > 2 ||
          (version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 292))))
      )
        this.supported = true;
    }
    if (message.subtype === "background_tasks_changed") {
      this.supported = true;
      this.liveTasks = new Set(message.tasks.map((task) => task.task_id));
      for (const id of this.liveTasks) this.awaitingNotifications.add(id);
    }
    if (message.subtype === "task_notification") {
      this.awaitingNotifications.delete(message.task_id);
    }
  }

  canStopRuntime(): boolean {
    return this.supported && this.liveTasks.size === 0 && this.awaitingNotifications.size === 0;
  }
}
