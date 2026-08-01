import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { VoiceLiveAgentUpdate } from "@getpaseo/protocol/live-voice-routing";

import { watchAgentFinish, type AgentFinishReason } from "../agent/agent-prompt.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { redactModelFacingText } from "../agent/model-facing-redaction.js";

/**
 * The wire reasons. `needs permission` is spelled with an underscore on the wire
 * because it is an identifier there, not prose.
 */
const WIRE_REASONS: Record<AgentFinishReason, string> = {
  finished: "turn_completed",
  errored: "errored",
  "needs permission": "needs_permission",
};

/**
 * The summary is read out loud after another model has already condensed it, so
 * it only has to carry enough for that. Long agent transcripts are cut here
 * rather than on the way into a realtime session, where they cost the call's
 * whole context budget.
 */
const MAX_SUMMARY_LENGTH = 1_200;

export interface LiveVoiceAgentNotifierOptions {
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">;
  agentStorage: Pick<AgentStorage, "get">;
  logger: Logger;
}

export interface WatchAllLiveVoiceAgentsParams {
  /** The socket that asked to be told about everything. Watches die with it. */
  sourceKey: object;
  emit: (update: VoiceLiveAgentUpdate) => void;
}

export interface WatchLiveVoiceAgentParams {
  agentId: string;
  /** The routed tool call that started this work; echoed back for correlation. */
  requestId: string;
  /** The socket that issued the routed tool call. Watches die with it. */
  sourceKey: object;
  emit: (update: VoiceLiveAgentUpdate) => void;
}

/**
 * Watches work a routed Live Voice tool call started on this daemon and reports
 * its outcome to the socket that started it.
 *
 * This daemon deliberately knows nothing about the call the work belongs to: it
 * has no liveSessionId, no idea which host is hosting the conversation, and no
 * way to address any socket but the one that asked. Correlating the report back
 * to a call is the client's job, and the client is the only party that can do it
 * without one daemon trusting another.
 */
export class LiveVoiceAgentNotifier {
  private readonly agentManager: LiveVoiceAgentNotifierOptions["agentManager"];
  private readonly agentStorage: LiveVoiceAgentNotifierOptions["agentStorage"];
  private readonly logger: Logger;
  private readonly cancelsBySource = new Map<object, Set<() => void>>();
  private readonly ambientBySource = new Map<object, () => void>();

  constructor(options: LiveVoiceAgentNotifierOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.logger = options.logger.child({ module: "live-voice-agent-notifier" });
  }

  watch(params: WatchLiveVoiceAgentParams): void {
    const cancels = this.cancelsBySource.get(params.sourceKey) ?? new Set<() => void>();
    this.cancelsBySource.set(params.sourceKey, cancels);

    let cancelInner: () => void = () => undefined;
    const cancel = (): void => cancelInner();
    cancels.add(cancel);
    const forget = (): void => {
      cancels.delete(cancel);
      if (cancels.size === 0) {
        this.cancelsBySource.delete(params.sourceKey);
      }
    };

    cancelInner = watchAgentFinish({
      agentManager: this.agentManager,
      agentId: params.agentId,
      continueAfterPermission: true,
      onFinish: (reason, details) => {
        if (details.terminal) {
          forget();
        }
        void this.report(params, reason, details.turnId).catch((error) => {
          this.logger.warn(
            { err: error, agentId: params.agentId, reason },
            "live_voice.agent_notify.report_failed",
          );
        });
      },
    });
  }

  /**
   * Watches every agent on this daemon for one socket, not just work that socket
   * started.
   *
   * This cannot reuse {@link watchAgentFinish}: that watches one known agent and
   * fires once, whereas here the set of agents is open and each one keeps having
   * turns for as long as the call lasts. Agents that appear mid-call are picked
   * up because the subscription is global rather than a set of per-agent ones.
   *
   * Global subscribers never see internal agents, so the hidden host running the
   * call cannot report on itself.
   */
  watchAll(params: WatchAllLiveVoiceAgentsParams): void {
    if (this.ambientBySource.has(params.sourceKey)) {
      return;
    }
    // An agent going idle only means a turn ended if we saw it run. Without this
    // every agent already sitting idle would report the moment anything else on
    // the daemon changed.
    const running = new Set<string>();
    const reportedPermissionIds = new Set<string>();

    const unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          const { id, lifecycle } = event.agent;
          if (lifecycle === "running") {
            running.add(id);
            return;
          }
          if (lifecycle === "closed") {
            running.delete(id);
            return;
          }
          if (lifecycle === "error") {
            running.delete(id);
            this.emitReport({ agentId: id, emit: params.emit }, "errored");
            return;
          }
          if (lifecycle === "idle" && running.delete(id)) {
            this.emitReport({ agentId: id, emit: params.emit }, "finished");
          }
          return;
        }

        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          const permissionId = event.event.request.id;
          if (reportedPermissionIds.has(permissionId)) {
            return;
          }
          reportedPermissionIds.add(permissionId);
          this.emitReport(
            { agentId: event.agentId, emit: params.emit },
            "needs permission",
            event.event.turnId,
          );
        }
      },
      { replayState: false },
    );

    this.ambientBySource.set(params.sourceKey, unsubscribe);
  }

  stopWatchingAll(sourceKey: object): void {
    const unsubscribe = this.ambientBySource.get(sourceKey);
    if (!unsubscribe) {
      return;
    }
    this.ambientBySource.delete(sourceKey);
    unsubscribe();
  }

  isWatchingAll(sourceKey: object): boolean {
    return this.ambientBySource.has(sourceKey);
  }

  /** The socket went away; nothing it started has anywhere left to report to. */
  releaseForSource(sourceKey: object): void {
    this.stopWatchingAll(sourceKey);
    const cancels = this.cancelsBySource.get(sourceKey);
    if (!cancels) {
      return;
    }
    this.cancelsBySource.delete(sourceKey);
    for (const cancel of cancels) {
      cancel();
    }
  }

  dispose(): void {
    const sourceKeys = new Set([...this.cancelsBySource.keys(), ...this.ambientBySource.keys()]);
    for (const sourceKey of sourceKeys) {
      this.releaseForSource(sourceKey);
    }
  }

  getWatchCount(): number {
    let count = 0;
    for (const cancels of this.cancelsBySource.values()) {
      count += cancels.size;
    }
    return count;
  }

  /**
   * Ambient reports have no routed tool call to be correlated against, so they
   * carry a fresh id and say so. The client matches them to a call by which host
   * it enabled the ambient watch on.
   */
  private emitReport(
    params: { agentId: string; emit: (update: VoiceLiveAgentUpdate) => void },
    reason: AgentFinishReason,
    turnId?: string,
  ): void {
    void this.report(
      { ...params, requestId: `ambient-${randomUUID()}`, sourceKey: params.emit },
      reason,
      turnId,
      { unsolicited: true },
    ).catch((error) => {
      this.logger.warn(
        { err: error, agentId: params.agentId, reason },
        "live_voice.agent_notify.ambient_report_failed",
      );
    });
  }

  private async report(
    params: WatchLiveVoiceAgentParams,
    reason: AgentFinishReason,
    turnId?: string,
    options: { unsolicited?: boolean } = {},
  ): Promise<void> {
    const record = await this.agentStorage.get(params.agentId);
    const title = record?.title?.trim() || params.agentId;
    const snapshot = this.agentManager.getAgent(params.agentId);
    const wireReason =
      reason === "errored" && snapshot?.lastFailure?.kind === "authentication_required"
        ? "authentication_required"
        : WIRE_REASONS[reason];
    const lastAssistantMessage = await this.agentManager.getLastAssistantMessage(params.agentId);
    params.emit({
      type: "voice.live.agent.update",
      payload: {
        requestId: params.requestId,
        notification: {
          agentId: params.agentId,
          title,
          reason: wireReason,
          scope: "agent_turn",
          ...(turnId ? { turnId } : {}),
          ...(options.unsolicited ? { unsolicited: true } : {}),
          summary: redactAndTruncateSummary(lastAssistantMessage),
        },
      },
    });
    this.logger.debug(
      { agentId: params.agentId, requestId: params.requestId, reason },
      "live_voice.agent_notify.reported",
    );
  }
}

function redactAndTruncateSummary(message: string | null): string | null {
  const trimmed = message?.trim();
  if (!trimmed) {
    return null;
  }
  const redacted = redactModelFacingText(trimmed);
  return redacted.length <= MAX_SUMMARY_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_SUMMARY_LENGTH)}…`;
}
