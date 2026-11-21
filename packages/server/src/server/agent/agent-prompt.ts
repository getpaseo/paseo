import {
  prepareAgentMessage,
  type AgentMessageDelivery,
  type AgentPromptSource,
} from "./agent-messages/index.js";
import type { Logger } from "pino";

import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { ForegroundPromptStart } from "./agent-run-state.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "reloadStalePluginSession"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export class AgentTurnBusyError extends Error {}

export interface StartAgentRunOptions {
  idleOnly?: boolean;
  admit?: () => boolean;
  /** Called after selecting the run, before consuming its events. */
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

/** A dispatched prompt. A started turn carries its sender's start outcome. */
export type PromptDispatchResult =
  | { disposition: "turn_started"; started: Promise<void> }
  | { disposition: Exclude<PromptDispatchDisposition, "turn_started"> };

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
  promptStart: ForegroundPromptStart,
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
  const result = await agentManager.steerOrReplaceActiveTurn(
    agentId,
    prompt,
    steerOptions,
    promptStart,
  );
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
  promptStart: ForegroundPromptStart,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions, promptStart)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions, promptStart);
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
): Promise<PromptDispatchResult> {
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
  const admit = options?.admit;
  const admitCommand = admit
    ? () => {
        if (!admit()) throw new Error("Queued agent message was withdrawn");
      }
    : undefined;
  if (await agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions, admitCommand)) {
    options?.onDispatch?.("out_of_band");
    return { disposition: "out_of_band" };
  }
  const promptStart = new ForegroundPromptStart(agentId, admit);
  try {
    try {
      await agentManager.reloadStalePluginSession(agentId);
      return await startAgentRunInner(agentManager, agentId, prompt, logger, options, promptStart);
    } catch (error) {
      if (!isStaleProviderSessionError(error)) throw error;
      logger.info(
        { agentId, err: error },
        "Provider session went stale; reopening from persistence",
      );
      // The live session belongs to a retired plugin runtime. Reload swaps in a
      // fresh session on the current runtime while preserving history and labels.
      await agentManager.reloadAgentSession(agentId);
      return await startAgentRunInner(agentManager, agentId, prompt, logger, options, promptStart);
    }
  } catch (error) {
    promptStart.end();
    throw error;
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options: StartAgentRunOptions | undefined,
  promptStart: ForegroundPromptStart,
): Promise<PromptDispatchResult> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = options?.idleOnly
    ? null
    : await steerOrReplaceActiveRun(agentManager, agentId, prompt, options, promptStart);
  if (options?.idleOnly && agentManager.hasInFlightRun(agentId)) {
    throw new AgentTurnBusyError(`Agent ${agentId} is running`);
  }
  if (steered?.disposition === "steered") {
    options?.onDispatch?.("steered");
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options, promptStart);
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
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options, promptStart);
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
    } finally {
      promptStart.end();
    }
  })();
  return { disposition: "turn_started", started: promptStart.started };
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
  idleOnly?: boolean;
  admit?: StartAgentRunOptions["admit"];
  /** Awaited after the agent is loaded and its mode is set, before the prompt is handed to a run. */
  beforeDispatch?: () => Promise<void>;
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

/** A prompt that does not wait its turn. Messages queued for the agent go with it. */
export interface SendDirectPromptParams extends SendPromptToAgentParams {
  agentMessages: Pick<AgentMessageDelivery, "sendDirect">;
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
  agentManager: Pick<AgentManager, "getAgent">,
  agentId: string,
  started: Promise<void>,
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

  const abortSignal = signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal;
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(createStartAbortError(abortSignal.reason));
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([started, aborted]);
  } finally {
    clearTimeout(startTimeout);
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }
}

function createStartAbortError(reason: unknown): Error {
  let message = "wait_for_agent_start aborted";
  if (typeof reason === "string") message = reason;
  else if (reason instanceof Error) message = reason.message;
  return Object.assign(new Error(message), { name: "AbortError" });
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage,
): Promise<AgentPromptSource | undefined> {
  if (!source || source.kind === "change-request-update" || source.title) return source;
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
 * The prompt does not wait in the agent's message queue, and it does not jump it either:
 * messages already queued for the agent are delivered ahead of it in the same provider prompt.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendDirectPromptParams,
): Promise<PromptDispatchResult> {
  const { agentMessages, source, messageId, ...send } = params;
  return agentMessages.sendDirect(
    {
      recipientId: params.agentId,
      prompt: params.prompt,
      source: await resolvePromptSource(source, params.agentManager, params.agentStorage),
      messageId,
      sessionMode: params.sessionMode,
      unarchive: params.unarchive,
    },
    (joined) =>
      sendPreparedPromptToAgent({
        ...send,
        prompt: joined.prompt,
        sessionMode: joined.sessionMode,
        unarchive: joined.unarchive,
        runOptions: joined.messageId
          ? { ...send.runOptions, clientMessageId: joined.messageId }
          : send.runOptions,
      }),
  );
}

/** Dispatch daemon-prepared context without reclassifying it as human input. */
export async function sendPreparedPromptToAgent(
  params: Omit<SendPromptToAgentParams, "source" | "messageId">,
): Promise<PromptDispatchResult> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started", started: Promise.resolve() };
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

  if (params.idleOnly && params.agentManager.hasInFlightRun(params.agentId)) {
    throw new AgentTurnBusyError(`Agent ${params.agentId} is running`);
  }
  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  await params.beforeDispatch?.();
  if (!params.idleOnly && params.admit?.() === false) {
    throw new Error("Queued agent message was withdrawn");
  }
  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: !params.idleOnly,
    idleOnly: params.idleOnly,
    admit: params.admit,
    onDispatch: params.onDispatch,
    activeTurnBehavior: params.activeTurnBehavior,
    clearPendingPermissions: params.clearPendingPermissions,
    runOptions: params.runOptions,
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
    await waitForAgentRunStartWithTimeout(
      params.agentManager,
      params.agentId,
      dispatchResult.started,
    );
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}
