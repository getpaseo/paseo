import type { Logger } from "pino";

import type { AgentPermissionResponse, AgentPermissionResult } from "./agent-sdk-types.js";
import type { AgentManagerEvent, SubscribeOptions } from "./agent-manager.js";
import { startAgentRun, type AgentRunController } from "./agent-prompt.js";

export interface PermissionResponseAgentManager extends AgentRunController {
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  subscribe(callback: (event: AgentManagerEvent) => void, options?: SubscribeOptions): () => void;
}

export interface RespondToAgentPermissionParams {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
  logger: Logger;
}

/** Cap how long we wait for a plan turn to settle before starting a follow-up. */
const FOLLOW_UP_TURN_TIMEOUT_MS = 30_000;

type PlanningTurnSettlement = "completed" | "canceled" | "failed";

export class PlanningTurnFollowUpTimeoutError extends Error {
  readonly agentId: string;
  readonly turnId: string;
  readonly timeoutMs: number;

  constructor(params: { agentId: string; turnId: string; timeoutMs: number }) {
    super(
      `Timed out waiting for agent ${params.agentId} planning turn ${params.turnId} to complete before starting the follow-up prompt`,
    );
    this.name = "PlanningTurnFollowUpTimeoutError";
    this.agentId = params.agentId;
    this.turnId = params.turnId;
    this.timeoutMs = params.timeoutMs;
  }
}

export async function respondToAgentPermission(
  params: RespondToAgentPermissionParams,
): Promise<void> {
  const { agentManager, agentId, requestId, response, logger } = params;
  logger.debug(
    { agentId, requestId },
    `Handling permission response for agent ${agentId}, request ${requestId}`,
  );

  // Capture the planning turn before answering so we can tell completed from Stop.
  // Subscribe first — CreatePlan may settle while respondToPermission awaits.
  const planningTurnId = agentManager.getAgent(agentId)?.activeForegroundTurnId ?? null;
  const settlementWatcher =
    planningTurnId !== null
      ? watchPlanningTurnSettlement({ agentManager, agentId, turnId: planningTurnId })
      : null;

  try {
    const result = await agentManager.respondToPermission(agentId, requestId, response);
    logger.debug({ agentId }, `Permission response forwarded to agent ${agentId}`);

    if (!result?.followUpPrompt) {
      return;
    }

    const replaceRunning = result.replaceRunning !== false;
    if (!replaceRunning) {
      if (!settlementWatcher) {
        logger.info(
          { agentId },
          "Skipping follow-up prompt: no planning turn was active at approval",
        );
        return;
      }

      const settlement = await settlementWatcher.wait(FOLLOW_UP_TURN_TIMEOUT_MS);
      if (settlement !== "completed") {
        logger.info(
          { agentId, planningTurnId, settlement },
          "Skipping follow-up prompt because the planning turn did not complete",
        );
        return;
      }
    }

    logger.debug(
      { agentId, replaceRunning },
      "Permission response requires follow-up turn, starting agent stream",
    );
    await startAgentRun(agentManager, agentId, result.followUpPrompt, logger, {
      replaceRunning,
    });
  } finally {
    settlementWatcher?.dispose();
  }
}

function watchPlanningTurnSettlement(params: {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  turnId: string;
}): {
  wait: (timeoutMs: number) => Promise<PlanningTurnSettlement>;
  dispose: () => void;
} {
  const { agentManager, agentId, turnId } = params;
  let settled: PlanningTurnSettlement | null = null;
  let resolveWait: ((outcome: PlanningTurnSettlement) => void) | null = null;
  let rejectWait: ((error: Error) => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const finish = (outcome: PlanningTurnSettlement) => {
    if (settled !== null) {
      return;
    }
    settled = outcome;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    unsubscribe();
    resolveWait?.(outcome);
  };

  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_stream" || event.agentId !== agentId) {
        return;
      }
      const streamEvent = event.event;
      if (
        streamEvent.type !== "turn_completed" &&
        streamEvent.type !== "turn_canceled" &&
        streamEvent.type !== "turn_failed"
      ) {
        return;
      }
      if (streamEvent.turnId != null && streamEvent.turnId !== turnId) {
        return;
      }
      if (streamEvent.type === "turn_completed") {
        finish("completed");
        return;
      }
      if (streamEvent.type === "turn_canceled") {
        finish("canceled");
        return;
      }
      finish("failed");
    },
    { agentId, replayState: false },
  );

  return {
    dispose: () => {
      unsubscribe();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
    wait: (timeoutMs) =>
      new Promise<PlanningTurnSettlement>((resolve, reject) => {
        if (settled !== null) {
          resolve(settled);
          return;
        }
        resolveWait = resolve;
        rejectWait = reject;
        timeoutId = setTimeout(() => {
          unsubscribe();
          rejectWait?.(
            new PlanningTurnFollowUpTimeoutError({
              agentId,
              turnId,
              timeoutMs,
            }),
          );
        }, timeoutMs);
      }),
  };
}
