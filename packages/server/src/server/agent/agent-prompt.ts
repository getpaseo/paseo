import { prepareAgentMessage, type AgentPromptSource } from "./agent-messages/index.js";
import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "hasBlockingRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  /** Called after selecting the run, before consuming its events. */
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasBlockingRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
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
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    options?.onDispatch?.("out_of_band");
    return { disposition: "out_of_band" };
  }
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    options?.onDispatch?.("steered");
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  options?.onDispatch?.("turn_started");
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
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
  return { disposition: "turn_started" };
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

export interface SendPromptToAgentParams {
  onDispatch?: StartAgentRunOptions["onDispatch"];
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentStorage: AgentStorage;
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, {
      signal: signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal,
    });
  } finally {
    clearTimeout(startTimeout);
  }
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage,
): Promise<AgentPromptSource | undefined> {
  if (!source) return undefined;
  const title = (
    manager.getAgent(source.agentId)?.config.title ?? (await storage.get(source.agentId))?.title
  )?.trim();
  return title ? { ...source, title } : source;
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    if (await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId)) {
      archivedAtToRestore = record.archivedAt;
    }
  }

  try {
    await ensureAgentLoaded(params.agentId, {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      logger: params.logger,
    });
  } catch (error) {
    // A send that could not load the agent leaves it where it was: still archived.
    // Concurrent sends share this load, so none of them holds a live session.
    if (archivedAtToRestore) {
      await params.agentManager.archiveSnapshot(params.agentId, archivedAtToRestore);
    }
    throw error;
  }

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const source = await resolvePromptSource(params.source, params.agentManager, params.agentStorage);
  const delivery = prepareAgentMessage(params.prompt, source, params.messageId);
  const runOptions = delivery.messageId
    ? { ...params.runOptions, clientMessageId: delivery.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, delivery.prompt, params.logger, {
    replaceRunning: true,
    onDispatch: params.onDispatch,
    activeTurnBehavior: params.activeTurnBehavior,
    clearPendingPermissions: params.clearPendingPermissions,
    runOptions,
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

  const delivery = prepareAgentMessage(
    params.prompt,
    await resolvePromptSource(params.source, params.agentManager, params.agentStorage),
    params.runOptions?.clientMessageId,
  );
  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    delivery.prompt,
    params.logger,
    { runOptions: { ...params.runOptions, clientMessageId: delivery.messageId } },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  /** A replacement must observe its new start, not the displaced running snapshot. */
  waitForTurnStart?: boolean;
  logger: Logger;
}

type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

const finishNotificationEvents = {
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
} as const;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

// A caller waits on a child through one armed notification. Arming again, such as a
// follow-up prompt while the child still runs, replaces the earlier one so the child's
// next finish reaches the caller once.
const armedFinishNotifications = new WeakMap<AgentManager, Map<string, () => void>>();

export function setupFinishNotification(params: SetupFinishNotificationParams): () => void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    waitForTurnStart = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let hasSeenTurn = false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();

  const armedByManager = armedFinishNotifications.get(agentManager) ?? new Map();
  armedFinishNotifications.set(agentManager, armedByManager);
  const armedKey = JSON.stringify([childAgentId, callerAgentId]);
  armedByManager.get(armedKey)?.();
  armedByManager.set(armedKey, stop);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    if (armedByManager.get(armedKey) === stop) {
      armedByManager.delete(armedKey);
    }
  }

  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<void> {
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: body,
      source: {
        kind: "agent-notification",
        agentId: childAgentId,
        event: finishNotificationEvents[reason],
      },
      activeTurnBehavior: "steer",
      unarchive: false,
      logger,
    });
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    if (options.terminal ?? true) stop();
    notificationQueue = notificationQueue
      .then(() => notify(reason, options.permissionRequest))
      .catch((error) => {
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to notify caller agent",
        );
      });
  }

  function observeState(agent: ManagedAgent): void {
    for (const requestId of notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running") {
      if (waitForTurnStart && !hasSeenTurn) return;
      hasSeenTurn = true;
      if (agent.pendingPermissions.size === 0) {
        hasSeenRunning = true;
      }
      return;
    }
    // Prior terminal state is not this task's outcome. A failure before turn start
    // is reported by the dispatch acknowledgement instead of a finish callback.
    if (agent.lifecycle === "error" && hasSeenTurn) {
      notifySafely("errored");
      return;
    }
    if (agent.lifecycle === "idle" && hasSeenRunning) {
      notifySafely("finished");
      return;
    }
    if (agent.lifecycle === "closed") {
      notifySafely("was closed");
      return;
    }
    return;
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        observeState(event.agent);
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "turn_started") {
        hasSeenTurn = true;
        hasSeenRunning = true;
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
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
    stop();
    return stop;
  }
  if (childSnapshot.lifecycle === "running" && !waitForTurnStart) {
    hasSeenTurn = true;
    hasSeenRunning = true;
  }
  return stop;
}
