import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions, AgentStreamEvent } from "./agent-sdk-types.js";
import type { AgentManager, AgentRunLifecycleHooks, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  "getAgent" | "tryRunOutOfBand" | "hasInFlightRun" | "replaceAgentRun" | "streamAgent"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
  lifecycleHooks?: AgentRunLifecycleHooks;
}

async function createAgentRunIterator(params: {
  agentManager: AgentRunController;
  agentId: string;
  prompt: AgentPromptInput;
  shouldReplace: boolean;
  runOptions?: AgentRunOptions;
  lifecycleHooks?: AgentRunLifecycleHooks;
}): Promise<AsyncGenerator<AgentStreamEvent>> {
  if (params.shouldReplace) {
    if (params.lifecycleHooks) {
      return await params.agentManager.replaceAgentRun(
        params.agentId,
        params.prompt,
        params.runOptions,
        params.lifecycleHooks,
      );
    }
    return await params.agentManager.replaceAgentRun(
      params.agentId,
      params.prompt,
      params.runOptions,
    );
  }
  if (params.lifecycleHooks) {
    return params.agentManager.streamAgent(
      params.agentId,
      params.prompt,
      params.runOptions,
      params.lifecycleHooks,
    );
  }
  return params.agentManager.streamAgent(params.agentId, params.prompt, params.runOptions);
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ outOfBand: boolean }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt)) {
    return { outOfBand: true };
  }
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = await createAgentRunIterator({
    agentManager,
    agentId,
    prompt,
    shouldReplace,
    runOptions: options?.runOptions,
    lifecycleHooks: options?.lifecycleHooks,
  });
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { outOfBand: false };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and coordinator resume.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  lifecycleHooks?: AgentRunLifecycleHooks;
  replaceRunning?: boolean;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, coordinator resume).
   */
  unarchive?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  lifecycleHooks?: AgentRunLifecycleHooks;
  logger: Logger;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const startAbort = new AbortController();
  const startTimeout = setTimeout(() => startAbort.abort("timeout"), AGENT_RUN_START_TIMEOUT_MS);

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, coordinator resume) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns `{ outOfBand: false }`) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ outOfBand: boolean }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { outOfBand: false };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: params.replaceRunning ?? true,
    runOptions,
    lifecycleHooks: params.lifecycleHooks,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
      lifecycleHooks: params.lifecycleHooks,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}
