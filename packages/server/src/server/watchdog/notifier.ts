import path from "node:path";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import {
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";
import type { StoredWatchdogJob, WatchdogNotifier } from "./service.js";

export function watchdogWakeClientMessageId(jobId: string): string {
  return `paseo-watchdog-wake:${jobId}`;
}

export class AgentWatchdogNotifier implements WatchdogNotifier {
  constructor(
    private readonly paseoHome: string,
    private readonly agentManager: AgentManager,
    private readonly agentStorage: AgentStorage,
    private readonly logger: Logger,
  ) {}

  async notify(job: StoredWatchdogJob): Promise<"delivered" | "busy"> {
    const record = await this.agentStorage.get(job.agentId);
    if (!record) {
      throw new Error(`Watchdog target agent ${job.agentId} no longer exists`);
    }
    if (record.archivedAt) {
      throw new Error(`Watchdog target agent ${job.agentId} is archived`);
    }

    const agent = await ensureAgentLoaded(job.agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });

    const wakeMessageId = watchdogWakeClientMessageId(job.id);
    // Idempotent wake: if the canonical timeline already has this clientMessageId,
    // treat delivery as done without starting or steering another turn.
    // Check the live timeline first (covers same-process retries before durable commit),
    // then durable/canonical rows (covers daemon restart after the wake was recorded).
    const wakeAlreadyPresent = (item: { type: string; clientMessageId?: string }): boolean =>
      item.type === "user_message" && item.clientMessageId === wakeMessageId;
    if (this.agentManager.getTimeline(agent.id).some(wakeAlreadyPresent)) {
      return "delivered";
    }
    const timelineRows = await this.agentManager.getTimelineRows(agent.id);
    if (timelineRows.some((row) => wakeAlreadyPresent(row.item))) {
      return "delivered";
    }

    // Leave delivery pending while the agent is mid-turn or blocked on a permission.
    // Never interrupt an active run or clear pending permissions for a wake.
    if (this.agentManager.hasInFlightRun(agent.id)) {
      return "busy";
    }
    if (this.agentManager.getPendingPermissions(agent.id).length > 0) {
      return "busy";
    }

    const result = job.result;
    let outcome = `exit code ${result?.exitCode ?? "unknown"}`;
    if (result?.error) {
      outcome = `worker error: ${result.error}`;
    } else if (result?.signal) {
      outcome = `terminated by ${result.signal}`;
    }
    const logsDirectory = path.join(this.paseoHome, "watchdogs", "logs");
    const streamSummary = [
      result?.stdout
        ? `stdout bytes=${result.stdout.bytes} truncated=${result.stdout.truncated}`
        : null,
      result?.stderr
        ? `stderr bytes=${result.stderr.bytes} truncated=${result.stderr.truncated}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const body = [
      `[PASEO_WATCHDOG job=${job.id}]`,
      `Durable background job "${job.name}" finished with ${outcome}.`,
      `stdout: ${path.join(logsDirectory, `${job.id}.stdout.log`)}`,
      `stderr: ${path.join(logsDirectory, `${job.id}.stderr.log`)}`,
      ...(streamSummary ? [streamSummary] : []),
      "Inspect the artifacts, report the real result, and continue the interrupted task. Do not rerun the job unless the artifacts show it is necessary.",
    ].join("\n");

    const disposition = await sendPromptToAgent({
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentId: agent.id,
      prompt: formatSystemNotificationPrompt(body),
      // Deterministic id makes repeated wake attempts idempotent in the submitted-prompt timeline.
      messageId: wakeMessageId,
      activeTurnBehavior: "steer",
      replaceRunning: false,
      clearPendingPermissions: false,
      unarchive: false,
      logger: this.logger,
    });

    if (disposition.disposition === "turn_started") {
      await waitForAgentRunStartWithTimeout(this.agentManager, agent.id);
    }
    return "delivered";
  }
}
