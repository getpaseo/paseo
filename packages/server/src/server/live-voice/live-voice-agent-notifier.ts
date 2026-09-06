import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { VoiceLiveAgentUpdate } from "@getpaseo/protocol/live-voice-routing";

import { watchAgentFinish, type AgentFinishReason } from "../agent/agent-prompt.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { redactModelFacingText } from "../agent/model-facing-redaction.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";

/**
 * The wire reasons. `needs permission` is spelled with an underscore on the wire
 * because it is an identifier there, not prose.
 */
const WIRE_REASONS: Record<AgentFinishReason, string> = {
  finished: "turn_completed",
  errored: "errored",
  "needs permission": "needs_permission",
  "was closed": "closed",
};

/**
 * The summary is read out loud after another model has already condensed it, so
 * it only has to carry enough for that. Long agent transcripts are cut here
 * rather than on the way into a realtime session, where they cost the call's
 * whole context budget.
 */
const MAX_SUMMARY_LENGTH = 1_200;

export interface LiveVoiceAgentNotifierOptions {
  agentManager: Pick<
    AgentManager,
    "subscribe" | "listAgents" | "getAgent" | "getLastAssistantMessage"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  /**
   * Resolves where a finished agent's work lives. Read lazily because the
   * registries are wired after the notifier, and left optional so a caller with
   * neither reports the agent unplaced rather than not at all.
   */
  workspaceRegistry?: () => Pick<WorkspaceRegistry, "get"> | null;
  projectRegistry?: () => Pick<ProjectRegistry, "get"> | null;
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
  private readonly workspaceRegistry: LiveVoiceAgentNotifierOptions["workspaceRegistry"];
  private readonly projectRegistry: LiveVoiceAgentNotifierOptions["projectRegistry"];
  private readonly logger: Logger;
  private readonly cancelsBySource = new Map<object, Set<() => void>>();
  private readonly ambientBySource = new Map<object, () => void>();
  private readonly routedAgentsBySource = new Map<object, Map<string, number>>();

  constructor(options: LiveVoiceAgentNotifierOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.workspaceRegistry = options.workspaceRegistry;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger.child({ module: "live-voice-agent-notifier" });
  }

  watch(params: WatchLiveVoiceAgentParams): void {
    const routedAgents =
      this.routedAgentsBySource.get(params.sourceKey) ?? new Map<string, number>();
    this.routedAgentsBySource.set(params.sourceKey, routedAgents);
    routedAgents.set(params.agentId, (routedAgents.get(params.agentId) ?? 0) + 1);
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
      // Keep the claim through every subscriber handling this terminal event.
      queueMicrotask(() => {
        const remaining = (routedAgents.get(params.agentId) ?? 1) - 1;
        if (remaining > 0) routedAgents.set(params.agentId, remaining);
        else routedAgents.delete(params.agentId);
        if (
          routedAgents.size === 0 &&
          this.routedAgentsBySource.get(params.sourceKey) === routedAgents
        ) {
          this.routedAgentsBySource.delete(params.sourceKey);
        }
      });
    };
    let reportQueue = Promise.resolve();

    cancelInner = watchAgentFinish({
      agentManager: this.agentManager,
      agentId: params.agentId,
      continueAfterPermission: true,
      onFinish: (reason, details) => {
        if (details.terminal) {
          forget();
        }
        reportQueue = reportQueue
          .then(() => this.report(params, reason, details.turnId))
          .catch((error) => {
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
    const running = new Set(
      this.agentManager
        .listAgents()
        .filter((agent) => agent.lifecycle === "running")
        .map((agent) => agent.id),
    );
    const errored = new Set<string>();
    const reportedPermissionIds = new Set<string>();
    const reportQueues = new Map<string, Promise<void>>();
    let active = true;
    const enqueueReport = (agentId: string, reason: AgentFinishReason, turnId?: string): void => {
      if (this.routedAgentsBySource.get(params.sourceKey)?.has(agentId)) return;
      const previous = reportQueues.get(agentId) ?? Promise.resolve();
      const next = previous
        .then(() =>
          this.report(
            {
              agentId,
              emit: params.emit,
              requestId: `ambient-${randomUUID()}`,
              sourceKey: params.sourceKey,
            },
            reason,
            turnId,
            { unsolicited: true, shouldEmit: () => active },
          ),
        )
        .catch((error) => {
          this.logger.warn(
            { err: error, agentId, reason },
            "live_voice.agent_notify.ambient_report_failed",
          );
        });
      reportQueues.set(agentId, next);
      void next.finally(() => {
        if (reportQueues.get(agentId) === next) {
          reportQueues.delete(agentId);
        }
      });
    };

    const unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          const { id, lifecycle } = event.agent;
          if (lifecycle === "running") {
            errored.delete(id);
            running.add(id);
            return;
          }
          if (lifecycle === "closed") {
            running.delete(id);
            errored.delete(id);
            return;
          }
          if (lifecycle === "error") {
            running.delete(id);
            if (!errored.has(id)) {
              errored.add(id);
              enqueueReport(id, "errored");
            }
            return;
          }
          errored.delete(id);
          if (lifecycle === "idle" && running.delete(id)) {
            enqueueReport(id, "finished");
          }
          return;
        }

        if (event.type === "agent_stream" && event.event.type === "permission_requested") {
          const permissionId = `${event.agentId}\0${event.event.request.id}`;
          if (reportedPermissionIds.has(permissionId)) {
            return;
          }
          reportedPermissionIds.add(permissionId);
          enqueueReport(event.agentId, "needs permission", event.event.turnId);
        }
      },
      { replayState: false },
    );

    this.ambientBySource.set(params.sourceKey, () => {
      active = false;
      unsubscribeAgentEvents();
    });
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
    this.routedAgentsBySource.delete(sourceKey);
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

  private async report(
    params: WatchLiveVoiceAgentParams,
    reason: AgentFinishReason,
    turnId?: string,
    options: { unsolicited?: boolean; shouldEmit?: () => boolean } = {},
  ): Promise<void> {
    const record = await this.agentStorage.get(params.agentId);
    const title = record?.title?.trim() || params.agentId;
    const snapshot = this.agentManager.getAgent(params.agentId);
    const wireReason =
      reason === "errored" && snapshot?.lastFailure?.kind === "authentication_required"
        ? "authentication_required"
        : WIRE_REASONS[reason];
    const lastAssistantMessage = await this.agentManager.getLastAssistantMessage(params.agentId);
    const placement = await this.resolvePlacement(record?.workspaceId);
    if (options.shouldEmit && !options.shouldEmit()) {
      return;
    }
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
          ...(placement.workspaceName ? { workspaceName: placement.workspaceName } : {}),
          ...(placement.projectName ? { projectName: placement.projectName } : {}),
          summary: redactAndTruncateSummary(lastAssistantMessage),
        },
      },
    });
    this.logger.debug(
      { agentId: params.agentId, requestId: params.requestId, reason },
      "live_voice.agent_notify.reported",
    );
  }

  /**
   * Where the work lives, in the names the user sees: the workspace's title if
   * they set one and the derived display name otherwise, and the same for its
   * project. Both are best-effort — an unplaceable agent is still worth
   * reporting.
   */
  private async resolvePlacement(
    workspaceId: string | undefined,
  ): Promise<{ workspaceName: string | null; projectName: string | null }> {
    const unplaced = { workspaceName: null, projectName: null };
    const registry = workspaceId ? this.workspaceRegistry?.() : null;
    if (!registry || !workspaceId) {
      return unplaced;
    }
    try {
      const workspace = await registry.get(workspaceId);
      if (!workspace) {
        return unplaced;
      }
      const projects = this.projectRegistry?.();
      const project = projects ? await projects.get(workspace.projectId) : null;
      return {
        workspaceName: workspace.title?.trim() || workspace.displayName?.trim() || null,
        projectName: project?.customName?.trim() || project?.displayName?.trim() || null,
      };
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId },
        "live_voice.agent_notify.placement_lookup_failed",
      );
      return unplaced;
    }
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
