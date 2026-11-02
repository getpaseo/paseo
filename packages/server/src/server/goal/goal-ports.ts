import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import type { TurnUsage } from "@getpaseo/protocol/goal/types";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentUsage,
  AgentUsageTotals,
} from "../agent/agent-sdk-types.js";
import { usageTotalsSince } from "../agent/usage-totals.js";
import { summarizeAgentActivity } from "../agent/activity-curator.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import { markPaseoWorktreeFirstAgentBranchAutoNameAttempted } from "../../utils/worktree-metadata.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type {
  ManagerAgentPort,
  ManagerWorkspacePort,
  PendingTurnRequest,
  TurnPermission,
  TurnResult,
  TurnWaitChange,
} from "./goal-manager.js";
import type { GoalModelCatalog } from "./goal-thinking.js";
import type { TimelineCursor } from "./run-watcher.js";
import { capText } from "@getpaseo/protocol/goal/interventions";
import { goalAutoModeId, type GoalModeCatalog } from "./goal-config-validation.js";
import { setAgentModeCommand } from "../agent/lifecycle-command.js";
import { MODE_APPLIES_NEXT_TURN_NOTICE } from "../agent/provider-notices.js";
import type { GoalPermissionPolicy } from "@getpaseo/protocol/goal/config-bounds";

interface DirectoryWorkspaceInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

interface WorktreeWorkspaceInput {
  cwd: string;
  firstAgentContext?: FirstAgentContext;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
}

const PERMISSION_POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TurnEnd =
  | { type: "turn_completed" }
  | { type: "turn_canceled" }
  | { type: "turn_failed"; error: string };

export interface TurnWatcher {
  /** How the turn ended according to the agent's own event stream, if it has. */
  end(): TurnEnd | null;
  /** The last reading the provider sent during the turn that carried accounting numbers. */
  reading(): AgentUsage | undefined;
  /** The turn's usage, as toTurnUsage reads `reading()` without a baseline. */
  usage(): TurnUsage | undefined;
  stop(): void;
}

const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const;

/**
 * The turn's usage, with one meaning for every provider: fresh input, cached input,
 * output and cost of the whole turn. Each field comes from the provider's `turnTotals`
 * when it has the field, else from the growth of its `sessionTotals` since `baseline`
 * (the totals after the agent's previous turn), else from the reading's own field.
 * Anything that is not a finite, non-negative number is dropped.
 */
export function toTurnUsage(
  usage: AgentUsage | undefined,
  baseline?: AgentUsageTotals,
): TurnUsage | undefined {
  if (!usage) return undefined;
  const reported: AgentUsageTotals = {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.totalCostUsd,
  };
  const sources = [
    usage.turnTotals ? usageTotalsSince(usage.turnTotals, undefined) : {},
    usage.sessionTotals ? usageTotalsSince(usage.sessionTotals, baseline) : {},
    usageTotalsSince(reported, undefined),
  ];
  const result: TurnUsage = {};
  for (const field of USAGE_FIELDS) {
    const value = sources.find((source) => source[field] !== undefined)?.[field];
    if (value !== undefined) result[field] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface TurnUsageMeter {
  /** The turn's usage from its last reading; remembers the agent's session totals for its next turn. */
  measure(agentId: string, reading: AgentUsage | undefined): TurnUsage | undefined;
}

/**
 * Measures each agent's turns from where its previous turn ended. What it remembers is
 * lost on restart: a provider that resumes its old count then reports the session so far
 * as the first turn after it.
 */
export function createTurnUsageMeter(): TurnUsageMeter {
  const baselines = new Map<string, AgentUsageTotals>();
  return {
    measure(agentId, reading) {
      const usage = toTurnUsage(reading, baselines.get(agentId));
      if (reading?.sessionTotals) {
        baselines.set(agentId, { ...baselines.get(agentId), ...reading.sessionTotals });
      }
      return usage;
    },
  };
}

function hasAccounting(usage: AgentUsage | undefined): usage is AgentUsage {
  return !!usage && toTurnUsage(usage) !== undefined;
}

/**
 * Watches an agent's event stream for how its turn ends. The wait API reports a
 * cancelled turn as an agent that went idle, so a stop pressed in the app would
 * otherwise look like success.
 */
export function watchTurn(
  subscribe: (listener: (event: AgentManagerEvent) => void) => () => void,
): TurnWatcher {
  let end: TurnEnd | null = null;
  let reading: AgentUsage | undefined;
  const unsubscribe = subscribe((event) => {
    if (end || event.type !== "agent_stream") return;
    const inner = event.event;
    // Providers report usage on turn completion or as updates during the turn; updates
    // that only describe the context window are skipped.
    if (
      (inner.type === "usage_updated" || inner.type === "turn_completed") &&
      hasAccounting(inner.usage)
    ) {
      reading = inner.usage;
    }
    if (inner.type === "turn_completed") end = { type: "turn_completed" };
    else if (inner.type === "turn_canceled") end = { type: "turn_canceled" };
    else if (inner.type === "turn_failed") end = { type: "turn_failed", error: inner.error };
  });
  return {
    end: () => end,
    reading: () => reading,
    usage: () => toTurnUsage(reading),
    stop: unsubscribe,
  };
}

interface AgentWait {
  status: string;
  permission: Partial<AgentPermissionRequest> | null;
  lastMessage: string | null;
}

/** Polls after an answered question for the follow-up turn its answer starts. */
const FOLLOW_UP_POLLS = 3;
/** Longest question or permission text a failure quotes. */
const PENDING_TEXT_LIMIT = 300;

/** What the agent is waiting for, from its pending request, for the failure text. */
export function pendingTurnRequest(request: Partial<AgentPermissionRequest>): PendingTurnRequest {
  const text = pendingRequestText(request);
  return {
    kind: request.kind === "question" ? "question" : "permission",
    tool: request.name ?? request.title ?? "a tool",
    ...(text ? { text } : {}),
  };
}

function pendingRequestText(request: Partial<AgentPermissionRequest>): string | undefined {
  const questions = request.input?.questions;
  const asked = Array.isArray(questions)
    ? questions
        .map((q: unknown) =>
          q && typeof q === "object" && "question" in q && typeof q.question === "string"
            ? q.question
            : "",
        )
        .filter(Boolean)
    : [];
  const detail = request.detail;
  const candidates = [
    asked.join(" / "),
    detail?.type === "plain_text" ? detail.text : undefined,
    detail?.type === "shell" ? detail.command : undefined,
    detail && "filePath" in detail ? detail.filePath : undefined,
    request.description,
    request.title,
  ];
  const text = candidates.find((c) => typeof c === "string" && c.trim())?.trim();
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ");
  return flat.length > PENDING_TEXT_LIMIT ? `${flat.slice(0, PENDING_TEXT_LIMIT - 1)}…` : flat;
}

/**
 * Whether `wait` keeps waiting on this request. A request on a running agent waits for its
 * answer. On an idle agent only a question does: Codex asks some questions without holding
 * the turn, and the answer starts a new one. Any other request left on an idle agent is one
 * a cancel left behind, which nobody will answer.
 */
function awaitsAnswer(wait: AgentWait): boolean {
  if (!wait.permission) return false;
  return (
    wait.status === "running" || (wait.status === "idle" && wait.permission.kind === "question")
  );
}

/**
 * Turns the next agent event into a turn result. Under the `wait` policy a
 * permission request stays pending in Paseo for a person to answer, and this
 * keeps polling while it waits; the caller's user-wait limit is what ends a request
 * nobody answers. A question answered after the turn ended starts a follow-up turn,
 * which this waits for too. A policy given as a function is read again on every
 * poll, so a goal switched to `fail` ends a turn that is waiting.
 *
 * `onWait` hears when a request has waited for at least one poll, so a request that clears
 * itself at once is never reported, and when that wait stops. A different request waiting
 * right after another is a new wait.
 */
export async function settleTurn(
  next: () => Promise<AgentWait>,
  policy: TurnPermission | (() => TurnPermission),
  agentId: string,
  pause: (ms: number) => Promise<void> = sleep,
  signal?: AbortSignal,
  onWait?: (change: TurnWaitChange) => void,
): Promise<TurnResult> {
  const current = typeof policy === "function" ? policy : () => policy;
  const waits = waitReporter(onWait);
  let wait = await next();
  let followUpPolls = 0;
  while (current() === "wait") {
    // The caller gave up on this turn: stop polling for a request nobody will answer.
    if (signal?.aborted) break;
    if (awaitsAnswer(wait)) {
      if (wait.status === "idle") followUpPolls = FOLLOW_UP_POLLS;
      waits.see(wait.permission);
    } else {
      waits.see(null);
      if (followUpPolls > 0 && !wait.permission && wait.status === "idle") {
        // Answered: give the follow-up turn a moment to start.
        followUpPolls -= 1;
      } else {
        break;
      }
    }
    await pause(PERMISSION_POLL_MS);
    wait = await next();
  }
  waits.stop();
  if (wait.permission) {
    return { outcome: "needs_permission", request: pendingTurnRequest(wait.permission) };
  }
  if (wait.status === "error") {
    return { outcome: "failed", error: wait.lastMessage ?? `Agent ${agentId} failed` };
  }
  return { outcome: "completed", text: wait.lastMessage?.trim() ?? "" };
}

/**
 * Tells `onWait` about the requests settleTurn sees at each poll: a request still there at the
 * next poll starts a wait, and the wait ends when it is gone or replaced, or the turn stops.
 */
function waitReporter(onWait: ((change: TurnWaitChange) => void) | undefined) {
  // The request seen at the previous poll, and whether its wait was reported.
  let seen: Partial<AgentPermissionRequest> | null = null;
  let reported = false;
  const end = (ended: boolean) => {
    if (reported) onWait?.(ended ? { waiting: false, ended: true } : { waiting: false });
    reported = false;
  };
  return {
    see(request: Partial<AgentPermissionRequest> | null) {
      if (!request || (seen && !sameRequest(seen, request))) end(false);
      else if (seen && !reported) {
        reported = true;
        onWait?.({ waiting: true, request: pendingTurnRequest(request) });
      }
      seen = request;
    },
    stop: () => end(true),
  };
}

function sameRequest(
  a: Partial<AgentPermissionRequest>,
  b: Partial<AgentPermissionRequest>,
): boolean {
  return a.id === undefined || b.id === undefined || a.id === b.id;
}

export interface GoalPortDeps {
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  cancelAgentRun: (agentId: string) => Promise<unknown>;
  createDirectoryWorkspace: (input: DirectoryWorkspaceInput) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  /** Resolves when the workspace's setup scripts have finished. */
  waitForWorkspaceSetup: (workspaceId: string) => Promise<void>;
  /** Model catalog that per-task thinking ids are checked against. */
  modelCatalog?: GoalModelCatalog;
  /** Mode catalog the `auto` policy looks for an auto mode in. Without it, `auto` acts as `wait`. */
  modeCatalog?: GoalModeCatalog;
  /** The mode a provider starts in when none is asked for; the `wait` policy's mode. */
  defaultModeId?: (provider: string, cwd: string) => Promise<string | null>;
}

/**
 * How a goal agent is created under each permission policy. `fail` uses the provider's
 * unattended mode. `wait` starts the provider's default mode, and its requests wait in
 * Paseo. `auto` asks for the provider's auto mode (see goalAutoModeId) when the provider
 * lists one, and otherwise starts as under `wait`.
 */
export async function goalAgentMode(
  deps: Pick<GoalPortDeps, "modeCatalog" | "logger">,
  input: { provider: string; cwd: string; permission: GoalPermissionPolicy | undefined },
): Promise<{ unattended: boolean; mode?: string }> {
  const policy = input.permission ?? "fail";
  if (policy === "fail") return { unattended: true };
  if (policy === "wait" || !deps.modeCatalog) return { unattended: false };
  try {
    const modes = await deps.modeCatalog(input.provider, input.cwd);
    const mode = goalAutoModeId(input.provider, modes);
    if (mode) return { unattended: false, mode };
  } catch (error) {
    deps.logger.warn({ err: error, provider: input.provider }, "Could not read provider modes");
  }
  deps.logger.info(
    { provider: input.provider },
    "Provider lists no auto mode; the goal agent starts in its default mode",
  );
  return { unattended: false };
}

/**
 * The mode a running goal agent is switched to when its goal's permission policy changes:
 * the mode a new agent would start in. Undefined when the provider names no such mode.
 */
export async function goalPolicyModeId(
  deps: Pick<GoalPortDeps, "modeCatalog" | "defaultModeId">,
  input: { provider: string; cwd: string; permission: GoalPermissionPolicy },
): Promise<string | undefined> {
  if (input.permission !== "wait" && deps.modeCatalog) {
    const modes = await deps.modeCatalog(input.provider, input.cwd);
    const mode =
      input.permission === "fail"
        ? modes.find((candidate) => candidate.isUnattended)?.id
        : goalAutoModeId(input.provider, modes);
    if (mode) return mode;
    // A provider without an unattended mode cannot honour `fail` on a running agent.
    if (input.permission === "fail") return undefined;
  }
  return (await deps.defaultModeId?.(input.provider, input.cwd)) ?? undefined;
}

/** A setup that never finishes must not hold a goal up forever. */
const SETUP_WAIT_MS = 5 * 60_000;

/** "codex/<model>" selects a provider and model; a bare id selects the provider only. */
function splitProviderModel(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: value }
    : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * Worktree setup scripts start in the background just after the worktree exists.
 * Agents and merges must not run against a tree that setup is still writing to.
 */
async function waitForSetup(deps: GoalPortDeps, workspaceId: string): Promise<void> {
  // Setup is registered from a timer the worktree workflow has already queued.
  await sleep(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      deps.logger.warn({ workspaceId }, "Worktree setup did not finish in time; continuing");
      resolve();
    }, SETUP_WAIT_MS);
  });
  try {
    await Promise.race([deps.waitForWorkspaceSetup(workspaceId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const IDLE_POLL_MS = 1000;

/**
 * Resolves when the agent has no run in flight: the same test streamAgent uses before it
 * refuses a second run. Rejects when `signal` aborts.
 */
export function waitForNoRun(
  agentManager: Pick<AgentManager, "hasInFlightRun" | "subscribe">,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    // Some state is cleared without an event (a run settling in its stream's finally), so the
    // state is also read again on a slow poll.
    let poll: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (done) return;
      if (!agentManager.hasInFlightRun(agentId)) {
        finish();
        return;
      }
      clearTimeout(poll);
      poll = setTimeout(check, IDLE_POLL_MS);
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(poll);
      unsubscribe?.();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error(`Waiting for agent ${agentId} to go idle was aborted`));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = agentManager.subscribe(check, { agentId, replayState: false });
    check();
  });
}

/** Rows read from the end of a timeline for running tools and the last error. */
const CURSOR_TAIL_ROWS = 20;
const LAST_ERROR_CHARS = 500;

/**
 * Where the agent's timeline stands: the raw sequence number, which grows with every row even
 * when rows merge for display, the last row's time, the tool calls still running in the latest
 * turn (several may run at once, and a finished one can come after a running one), and the last
 * error. Null for an agent not loaded.
 */
export function readTimelineCursor(
  agentManager: Pick<AgentManager, "fetchTimeline">,
  agentId: string,
): TimelineCursor | null {
  let fetched: ReturnType<AgentManager["fetchTimeline"]>;
  try {
    fetched = agentManager.fetchTimeline(agentId, { direction: "tail", limit: CURSOR_TAIL_ROWS });
  } catch {
    return null;
  }
  const last = fetched.rows.at(-1);
  const runningTools: TimelineCursor["runningTools"] = [];
  let lastError: string | undefined;
  for (const row of fetched.rows) {
    const { item } = row;
    if (item.type === "error") lastError = item.message;
    if (item.type !== "tool_call" || item.status !== "running") continue;
    if (last?.turnId !== undefined && row.turnId !== last.turnId) continue;
    runningTools.push({ callId: item.callId, name: item.name });
  }
  return {
    nextSeq: fetched.window.nextSeq,
    lastTimestamp: last?.timestamp ?? null,
    runningTools,
    ...(lastError === undefined ? {} : { lastError: capText(lastError, LAST_ERROR_CHARS) }),
  };
}

/** The agent's curated recent activity, the newest kept when cut to `maxChars`. */
export function readActivityDigest(
  agentManager: Pick<AgentManager, "getTimeline">,
  agentId: string,
  maxChars: number,
): string {
  const { content } = summarizeAgentActivity(agentManager.getTimeline(agentId), 30);
  return content.length <= maxChars ? content : `…${content.slice(content.length - maxChars + 1)}`;
}

export function createGoalAgentPort(deps: GoalPortDeps): ManagerAgentPort {
  const meter = createTurnUsageMeter();
  return {
    async createAgent(input) {
      const { provider, model } = splitProviderModel(input.provider);
      const { unattended, mode } = await goalAgentMode(deps, {
        provider,
        cwd: input.cwd,
        permission: input.permission,
      });
      const created = await deps.createAgent({
        kind: "mcp",
        provider: input.provider,
        config: { provider, cwd: input.cwd, ...(model ? { model } : {}) },
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        title: input.title,
        labels: input.labels,
        ...(input.thinking ? { thinking: input.thinking } : {}),
        unattended,
        ...(mode ? { mode } : {}),
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      // What the provider reports once the session is up, else what was asked for.
      const thinking =
        created.snapshot.runtimeInfo?.thinkingOptionId ??
        created.snapshot.config.thinkingOptionId ??
        input.thinking;
      return { agentId: created.snapshot.id, ...(thinking ? { thinking } : {}) };
    },

    async runTurn(agentId, prompt, options): Promise<TurnResult> {
      // runAgent would block on a pending permission; starting the turn and
      // waiting for the next agent event returns as soon as one is requested.
      const watcher = watchTurn((listener) => deps.agentManager.subscribe(listener, { agentId }));
      try {
        await startAgentRun(deps.agentManager, agentId, prompt, deps.logger);
        options?.onStarted?.();
        const result = await settleTurn(
          () => deps.agentManager.waitForAgentEvent(agentId, { waitForActive: true }),
          options?.permission ?? "fail",
          agentId,
          undefined,
          options?.signal,
          options?.onWait,
        );
        const end = watcher.end();
        const usage = meter.measure(agentId, watcher.reading());
        const reported = usage ? { usage } : {};
        if (end?.type === "turn_canceled") return { outcome: "canceled", ...reported };
        if (end?.type === "turn_failed")
          return { outcome: "failed", error: end.error, ...reported };
        return { ...result, ...reported };
      } finally {
        watcher.stop();
      }
    },

    async setPermissionMode(agentId, permission) {
      const agent = await ensureAgentLoaded(agentId, {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
      });
      const modeId = await goalPolicyModeId(deps, {
        provider: agent.provider,
        cwd: agent.cwd,
        permission,
      });
      if (!modeId) return null;
      // The path the app's mode picker takes.
      const { notice } = await setAgentModeCommand(
        { agentManager: deps.agentManager },
        { agentId: agent.id, modeId },
      );
      return { modeId, nextTurn: notice?.message === MODE_APPLIES_NEXT_TURN_NOTICE.message };
    },

    knownProviders: () => deps.agentManager.getRegisteredProviderIds(),

    async findAgents(labels) {
      const records = await deps.agentStorage.list();
      return records
        .filter(
          (record) =>
            !record.archivedAt &&
            Object.entries(labels).every(([key, value]) => record.labels[key] === value),
        )
        .map((record) => ({ agentId: record.id, workspaceId: record.workspaceId ?? null }));
    },

    async isBusy(agentId) {
      return deps.agentManager.hasInFlightRun(agentId);
    },

    async timelineCursor(agentId) {
      return readTimelineCursor(deps.agentManager, agentId);
    },

    async activityDigest(agentId, maxChars) {
      return readActivityDigest(deps.agentManager, agentId, maxChars);
    },

    async steer(agentId, text) {
      // A client message id records the steer in the timeline as a user message.
      const { status } = await deps.agentManager.steerActiveTurnOnly(agentId, text, {
        clientMessageId: randomUUID(),
      });
      return status === "steered" ? "steered" : "unavailable";
    },

    ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),

    async cancel(agentId) {
      await deps.cancelAgentRun(agentId);
    },

    async waitUntilIdle(agentId, signal) {
      // A Lead from before a restart is only on disk until something loads it.
      await ensureAgentLoaded(agentId, {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
      });
      await waitForNoRun(deps.agentManager, agentId, signal);
    },

    async notify(agentId, text) {
      const agent = await ensureAgentLoaded(agentId, {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
      });
      // Resolves once the prompt is steered into the running turn or has started a new one.
      const { disposition } = await startAgentRun(
        deps.agentManager,
        agent.id,
        formatSystemNotificationPrompt(text),
        deps.logger,
        { activeTurnBehavior: "steer" },
      );
      if (disposition === "out_of_band") {
        throw new Error(`Agent ${agentId} handled the notification as a command, not a prompt`);
      }
    },
  };
}

export function createGoalWorkspacePort(deps: GoalPortDeps): ManagerWorkspacePort {
  return {
    async create(input) {
      const firstAgentContext: FirstAgentContext = { prompt: input.title };
      if (input.isolation !== "worktree") {
        const workspace = await deps.createDirectoryWorkspace({
          cwd: input.cwd,
          firstAgentContext,
        });
        return { workspaceId: workspace.workspaceId, cwd: workspace.cwd };
      }
      const result = await deps.createPaseoWorktreeWorkspace({
        cwd: input.cwd,
        // Without a first-agent context the branch auto-namer is never scheduled.
        ...(input.keepBranchName ? {} : { firstAgentContext }),
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseRef ? { refName: input.baseRef, action: "branch-off" as const } : {}),
      });
      if (input.keepBranchName) {
        // Creating an agent here later must not trigger a rename either.
        try {
          await markPaseoWorktreeFirstAgentBranchAutoNameAttempted(result.worktree.worktreePath);
        } catch (error) {
          // The branch name is a convenience, not something worth failing the goal over.
          deps.logger.warn({ err: error }, "Could not pin the integration branch name");
        }
      }
      await waitForSetup(deps, result.workspace.workspaceId);
      return { workspaceId: result.workspace.workspaceId, cwd: result.workspace.cwd };
    },
    archive: (workspaceId) => deps.archiveWorkspace(workspaceId),
  };
}
