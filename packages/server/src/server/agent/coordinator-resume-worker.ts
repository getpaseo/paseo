import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent-prompt.js";
import type { AgentStorage } from "./agent-storage.js";
import { type CoordinatorResumeEvent, CoordinatorResumeStore } from "./coordinator-resume-store.js";

const DEFAULT_LEASE_MS = 30_000;

export interface CoordinatorResumeWorkerOptions {
  leaseMs?: number;
  now?: () => number;
}

export class CoordinatorResumeWorker {
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    readonly store: CoordinatorResumeStore,
    private readonly agentManager: AgentManager,
    private readonly agentStorage: AgentStorage,
    logger: Logger,
    options: CoordinatorResumeWorkerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? Date.now;
    this.logger = logger.child({ module: "agent", component: "coordinator-resume-worker" });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.store.reconcileStartup();
    this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  kick(): void {
    if (!this.running || this.inFlight) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const operation = this.drain()
      .catch((error) => {
        this.logger.error({ err: error }, "Coordinator resume worker failed");
      })
      .finally(() => {
        if (this.inFlight === operation) {
          this.inFlight = null;
        }
        void this.scheduleNext();
      });
    this.inFlight = operation;
  }

  async handleTurnTerminal(params: {
    agentId: string;
    turnId: string;
    outcome: "completed" | "failed" | "canceled";
  }): Promise<void> {
    const record = await this.agentStorage.get(params.agentId);
    if (params.outcome === "canceled") {
      await this.store.cancelChildTurn({
        childAgentId: params.agentId,
        childTurnId: params.turnId,
      });
    } else if (!record) {
      await this.store.markChildPolicy({
        childAgentId: params.agentId,
        childTurnId: params.turnId,
        state: "child_missing",
      });
    } else if (record.archivedAt) {
      await this.store.markChildPolicy({
        childAgentId: params.agentId,
        childTurnId: params.turnId,
        state: "child_archived",
      });
    } else {
      await this.store.promoteChild({
        childAgentId: params.agentId,
        childTurnId: params.turnId,
        outcome: params.outcome,
        currentParentAgentId: getParentAgentIdFromLabels(record.labels),
      });
    }

    await this.store.recordCoordinatorTerminal({
      coordinatorAgentId: params.agentId,
      coordinatorTurnId: params.turnId,
      outcome: params.outcome,
    });
    this.kick();
  }

  private async drain(): Promise<void> {
    await this.store.reconcile();
    while (this.running) {
      const event = await this.store.leaseNext({ leaseMs: this.leaseMs });
      if (!event) return;
      await this.deliver(event);
    }
  }

  private async deliver(event: CoordinatorResumeEvent): Promise<void> {
    const leaseId = event.leaseId;
    if (!leaseId) throw new Error(`Leased coordinator resume event has no lease: ${event.eventId}`);

    const child = await this.agentStorage.get(event.childAgentId);
    if (!child) {
      await this.store.markPolicy({ eventId: event.eventId, leaseId, state: "child_missing" });
      return;
    }
    if (child.archivedAt) {
      await this.store.markPolicy({ eventId: event.eventId, leaseId, state: "child_archived" });
      return;
    }
    if (getParentAgentIdFromLabels(child.labels) !== event.coordinatorAgentId) {
      await this.store.markPolicy({
        eventId: event.eventId,
        leaseId,
        state: "ownership_changed",
      });
      return;
    }

    const coordinator = await this.agentStorage.get(event.coordinatorAgentId);
    if (!coordinator) {
      await this.store.markPolicy({
        eventId: event.eventId,
        leaseId,
        state: "coordinator_missing",
      });
      return;
    }
    if (coordinator.archivedAt) {
      await this.store.markPolicy({
        eventId: event.eventId,
        leaseId,
        state: "coordinator_archived",
      });
      return;
    }
    if (
      coordinator.provider !== "codex" ||
      !this.agentManager.getRegisteredProviderIds().includes("codex")
    ) {
      await this.store.markPolicy({
        eventId: event.eventId,
        leaseId,
        state: "coordinator_unsupported",
      });
      return;
    }
    if (this.agentManager.hasInFlightRun(event.coordinatorAgentId)) {
      await this.store.releaseLease({ eventId: event.eventId, leaseId });
      return;
    }

    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId: event.coordinatorAgentId,
        prompt: formatSystemNotificationPrompt(
          [
            `Delegated agent ${event.childAgentId} ${event.childOutcome}.`,
            `Coordinator resume event: ${event.eventId}`,
            `Child turn: ${event.childTurnId}`,
            `Result locator: ${event.resultLocator}`,
            "Inspect the child timeline and process this event idempotently.",
          ].join("\n"),
        ),
        unarchive: false,
        replaceRunning: false,
        lifecycleHooks: {
          onTurnStarted: async (coordinatorTurnId) => {
            await this.store.markDelivered({
              eventId: event.eventId,
              leaseId,
              coordinatorTurnId,
            });
          },
          onTurnStartFailed: async () => {
            await this.store
              .releaseLease({ eventId: event.eventId, leaseId })
              .catch(() => undefined);
            this.kick();
          },
        },
        logger: this.logger,
      });
    } catch (error) {
      await this.store.releaseLease({ eventId: event.eventId, leaseId }).catch(() => undefined);
      this.logger.warn(
        { err: error, eventId: event.eventId, attempt: event.attempt },
        "Coordinator resume delivery failed",
      );
    }
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const nextWakeAt = await this.store.nextWakeAt();
    if (nextWakeAt === null) return;
    const delay = Math.max(0, nextWakeAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    this.timer.unref();
  }
}
