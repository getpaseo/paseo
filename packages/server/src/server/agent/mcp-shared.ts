import { z } from "zod";
import type { Logger } from "pino";

import type {
  AgentPromptInput,
  AgentPermissionRequest,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent, WaitForAgentResult } from "./agent-manager.js";
import { curateAgentActivity } from "./activity-curator.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { serializeAgentSnapshot } from "../messages.js";
import { StoredScheduleSchema } from "../schedule/types.js";
import type { AgentProvider } from "./agent-sdk-types.js";

export const AgentProviderEnum = z.string();

export const AgentStatusEnum = z.enum(["initializing", "idle", "running", "error", "closed"]);

export const ProviderModeSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    icon: z.string().nullish(),
    colorTier: z.string().nullish(),
  })
  .passthrough();

export const ProviderSummarySchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    modes: z.array(ProviderModeSchema).nullish(),
  })
  .passthrough();

export const AgentSelectOptionSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    isDefault: z.boolean().nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const AgentModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    isDefault: z.boolean().nullish(),
    metadata: z.record(z.unknown()).nullish(),
    thinkingOptions: z.array(AgentSelectOptionSchema).nullish(),
    defaultThinkingOptionId: z.string().nullish(),
  })
  .passthrough();

// 30 seconds - surface friendly message before SDK tool timeout (~60s)
export const AGENT_WAIT_TIMEOUT_MS = 30000;

export interface ResolvedProviderModel {
  provider: AgentProvider;
  model: string | undefined;
}

export function resolveProviderAndModel(params: {
  provider?: string;
  model?: string;
  defaultProvider: AgentProvider;
}): ResolvedProviderModel {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const modelInput = params.model?.trim();

  if (params.model !== undefined && !modelInput) {
    throw new Error("model cannot be empty");
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput as AgentProvider,
      model: modelInput,
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  if (modelInput && modelInput !== modelFromProvider) {
    throw new Error(
      `Conflicting model values provided: provider specifies ${modelFromProvider}, but model specifies ${modelInput}`,
    );
  }

  return {
    provider: provider as AgentProvider,
    model: modelInput ?? modelFromProvider,
  };
}

export type StartAgentRunOptions = {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
};

/**
 * Wraps agentManager.waitForAgentEvent with a self-imposed timeout.
 * Returns a friendly message when timeout occurs, rather than letting
 * the SDK tool timeout trigger a generic "tool failed" error.
 */
export async function waitForAgentWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  options?: {
    signal?: AbortSignal;
    waitForActive?: boolean;
  },
): Promise<WaitForAgentResult> {
  const timeoutController = new AbortController();
  const combinedController = new AbortController();

  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error("wait timeout"));
  }, AGENT_WAIT_TIMEOUT_MS);

  const forwardAbort = (reason: unknown) => {
    if (!combinedController.signal.aborted) {
      combinedController.abort(reason);
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      forwardAbort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => forwardAbort(options.signal!.reason), {
        once: true,
      });
    }
  }

  timeoutController.signal.addEventListener(
    "abort",
    () => forwardAbort(timeoutController.signal.reason),
    { once: true },
  );

  try {
    const result = await agentManager.waitForAgentEvent(agentId, {
      signal: combinedController.signal,
      waitForActive: options?.waitForActive,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "wait timeout") {
      const snapshot = agentManager.getAgent(agentId);
      const timeline = agentManager.getTimeline(agentId);
      const recentActivity = curateAgentActivity(timeline.slice(-5));
      const waitedSeconds = Math.round(AGENT_WAIT_TIMEOUT_MS / 1000);
      const message = `Awaiting the agent timed out after ${waitedSeconds}s. This does not mean the agent failed - call wait_for_agent again to continue waiting.\n\nRecent activity:\n${recentActivity}`;
      return {
        status: snapshot?.lifecycle ?? "idle",
        permission: null,
        lastMessage: message,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function startAgentRun(
  agentManager: AgentManager,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): void {
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const runOptions = options?.runOptions;
  const iterator = shouldReplace
    ? agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
    } catch (error) {
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  agentStorage: AgentStorage,
  agentManager: AgentManager,
  agentId: string,
): Promise<boolean> {
  const record = await agentStorage.get(agentId);
  if (!record || !record.archivedAt) {
    return false;
  }
  const updatedAt = new Date().toISOString();
  await agentStorage.upsert({
    ...record,
    archivedAt: null,
    updatedAt,
  });
  agentManager.notifyAgentState(agentId);
  return true;
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Raw user text to record in the timeline. */
  userMessageText: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  logger: Logger;
}

/**
 * Full send-prompt orchestration: unarchive → load → (optional mode change) →
 * record user message → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP)
 * MUST go through this so behavior can never drift between them.
 */
export async function sendPromptToAgent(params: SendPromptToAgentParams): Promise<void> {
  const {
    agentManager,
    agentStorage,
    agentId,
    userMessageText,
    prompt,
    messageId,
    runOptions,
    sessionMode,
    logger,
  } = params;

  await unarchiveAgentState(agentStorage, agentManager, agentId);

  await ensureAgentLoaded(agentId, {
    agentManager,
    agentStorage,
    logger,
  });

  if (sessionMode) {
    await agentManager.setAgentMode(agentId, sessionMode);
  }

  try {
    agentManager.recordUserMessage(agentId, userMessageText, {
      messageId,
      emitState: false,
    });
  } catch (error) {
    logger.error({ err: error, agentId }, "Failed to record user message");
  }

  startAgentRun(agentManager, agentId, prompt, logger, {
    replaceRunning: true,
    runOptions,
  });
}

interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  logger: Logger;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const { agentManager, agentStorage, childAgentId, callerAgentId, logger } = params;
  let hasSeenRunning = false;
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  async function notify(reason: "finished" | "errored" | "needs permission"): Promise<void> {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();

    if (!agentManager.getAgent(callerAgentId)) {
      return;
    }

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const title = agentManager.getAgent(childAgentId)?.config?.title ?? childAgentId;
    const prompt = `<paseo-system>\nAgent ${childAgentId} (${title}) ${reason}.\n</paseo-system>`;

    startAgentRun(agentManager, callerAgentId, prompt, logger, {
      replaceRunning: true,
    });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired) {
        return;
      }

      if (event.type === "agent_state") {
        if (event.agent.lifecycle === "running") {
          hasSeenRunning = true;
          return;
        }
        if (event.agent.lifecycle === "error") {
          notify("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notify("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          fired = true;
          unsubscribe?.();
          return;
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        notify("needs permission");
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    unsubscribe();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notify("errored");
  }
}

export function sanitizePermissionRequest(
  permission: AgentPermissionRequest | null | undefined,
): AgentPermissionRequest | null {
  if (!permission) {
    return null;
  }
  const sanitized: AgentPermissionRequest = { ...permission };
  if (sanitized.title === undefined) {
    delete sanitized.title;
  }
  if (sanitized.description === undefined) {
    delete sanitized.description;
  }
  if (sanitized.input === undefined) {
    delete sanitized.input;
  }
  if (sanitized.suggestions === undefined) {
    delete sanitized.suggestions;
  }
  if (sanitized.actions === undefined) {
    delete sanitized.actions;
  }
  if (sanitized.metadata === undefined) {
    delete sanitized.metadata;
  }
  return sanitized;
}

export async function resolveAgentTitle(
  agentStorage: AgentStorage,
  agentId: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const record = await agentStorage.get(agentId);
    return record?.title ?? null;
  } catch (error) {
    logger.error({ err: error, agentId }, "Failed to load agent title");
    return null;
  }
}

export async function serializeSnapshotWithMetadata(
  agentStorage: AgentStorage,
  snapshot: ManagedAgent,
  logger: Logger,
) {
  const title = await resolveAgentTitle(agentStorage, snapshot.id, logger);
  return serializeAgentSnapshot(snapshot, { title });
}

export function parseDurationString(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  let totalMs = 0;
  let hasMatch = false;
  const regex = /(\d+)([smh])/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(trimmed)) !== null) {
    hasMatch = true;
    const value = Number.parseInt(match[1], 10);
    switch (match[2]) {
      case "s":
        totalMs += value * 1000;
        break;
      case "m":
        totalMs += value * 60 * 1000;
        break;
      case "h":
        totalMs += value * 60 * 60 * 1000;
        break;
    }
  }

  if (!hasMatch) {
    throw new Error(`Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m`);
  }

  return totalMs;
}

export function toScheduleSummary(schedule: z.infer<typeof StoredScheduleSchema>) {
  const { runs: _runs, ...summary } = schedule;
  return summary;
}
