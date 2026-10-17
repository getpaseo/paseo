import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { startAgentRun, type AgentRunController } from "../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

// A run failed because its target no longer exists: the agent was deleted, or a
// new-agent cwd was removed. These are permanent, so the schedule is completed
// instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

// A run failed because its target agent is archived. Archive can be undone, so the
// schedule is paused for the archive and resumes when the agent is unarchived.
export class ScheduleTargetArchivedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetArchivedError";
  }
}

function advanceNextRunAtPast(
  cadence: StoredSchedule["cadence"],
  nextRunAt: Date,
  now: Date,
): Date {
  let next = nextRunAt;
  while (next.getTime() <= now.getTime()) {
    next = computeNextRunAt(cadence, next);
  }
  return next;
}

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  if (patch.thinkingOptionId !== undefined) {
    const trimmed = patch.thinkingOptionId?.trim();
    if (trimmed) {
      config.thinkingOptionId = trimmed;
    } else {
      delete config.thinkingOptionId;
    }
  }
  if (patch.archiveOnFinish !== undefined) {
    config.archiveOnFinish = patch.archiveOnFinish;
  }
  if (patch.isolation !== undefined) {
    config.isolation = patch.isolation;
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running").length;
}

function shouldArchiveScheduleRunWorkspace(input: {
  agentId: string | null;
  archiveOnFinish?: boolean;
}): boolean {
  return input.agentId === null || (input.archiveOnFinish ?? true);
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function requireSchedule(schedule: StoredSchedule | null, id: string): StoredSchedule {
  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }
  return schedule;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    pauseReason: null,
    updatedAt: now.toISOString(),
  };
}

// Pause an active schedule because its target agent was archived. A schedule the
// user already paused keeps its own pause, so unarchive leaves it paused.
function pauseScheduleForArchivedAgent(schedule: StoredSchedule, now: Date): StoredSchedule {
  if (schedule.status !== "active") {
    return schedule;
  }
  return {
    ...schedule,
    status: "paused",
    nextRunAt: null,
    pausedAt: now.toISOString(),
    pauseReason: "agent_archived",
    updatedAt: now.toISOString(),
  };
}

function isPausedForArchivedAgent(schedule: StoredSchedule): boolean {
  return schedule.status === "paused" && schedule.pauseReason === "agent_archived";
}

function resumeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "active",
    pausedAt: null,
    pauseReason: null,
    nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function mergeScheduleCadenceTimezone(
  current: StoredSchedule["cadence"],
  next: StoredSchedule["cadence"],
): StoredSchedule["cadence"] {
  if (
    current.type === "cron" &&
    next.type === "cron" &&
    next.timezone === undefined &&
    current.timezone !== undefined
  ) {
    return {
      ...next,
      timezone: current.timezone,
    };
  }
  return next;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

type ScheduleAgentManager = Pick<
  AgentRunController,
  | "getAgent"
  | "reloadAgentSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "runAgent"
    | "waitForAgentEvent"
    | "waitForAgentClose"
  >;

interface ScheduleWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

export interface ScheduleServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.logger = options.logger.child({ module: "schedule-service" });
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"), this.logger);
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createDirectoryWorkspace = options.createDirectoryWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.archiveWorkspace = options.archiveWorkspace;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule, runId) => this.executeSchedule(schedule, runId));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
    await this.sweepOrphanedSchedules();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    return this.store.create(this.buildScheduleRecord(input, fields));
  }

  private buildScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Omit<StoredSchedule, "id"> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return {
      name: fields.name,
      prompt: fields.prompt,
      cadence: input.cadence,
      target: fields.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
    };
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  async createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      create: async () => {
        return this.buildScheduleRecord(input, { name, prompt, target: inputTarget });
      },
      update: async (current) => {
        const now = this.now();
        const cadence = mergeScheduleCadenceTimezone(current.cadence, input.cadence);
        const runOnCreate = input.runOnCreate ?? cadence.type === "every";
        const nextRunAt = runOnCreate ? now : computeNextRunAt(cadence, now);
        return {
          ...current,
          name,
          prompt,
          cadence,
          target: inputTarget,
          status: "active",
          pausedAt: null,
          pauseReason: null,
          nextRunAt: nextRunAt.toISOString(),
          expiresAt: input.expiresAt ?? null,
          maxRuns: normalizeMaxRuns(input.maxRuns),
          updatedAt: now.toISOString(),
        };
      },
    });
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    return schedule;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        // Pausing a schedule the archive paused makes it the user's pause, so
        // unarchiving the agent leaves it paused.
        return schedule.pauseReason ? { ...schedule, pauseReason: null } : schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        pauseReason: null,
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(paused, id);
  }

  async resume(id: string): Promise<StoredSchedule> {
    const resumed = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      return resumeSchedule(schedule, this.now());
    });
    return requireSchedule(resumed, id);
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const next = await this.store.update(input.id, async (schedule) => {
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        const cadence = mergeScheduleCadenceTimezone(updated.cadence, input.cadence);
        validateScheduleCadence(cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(cadence, now).toISOString() : null;
        updated = { ...updated, cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        updated = {
          ...updated,
          target: patchedTarget,
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      return { ...updated, updatedAt: now.toISOString() };
    });
    return requireSchedule(next, input.id);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  // Archive can be undone, so archiving an agent pauses its active schedules
  // instead of completing them. unarchive resumes only these, not the ones the
  // user paused.
  async pauseForArchivedAgent(agentId: string): Promise<number> {
    return this.updateForAgent({
      agentId,
      applies: (schedule) => schedule.status === "active",
      change: pauseScheduleForArchivedAgent,
      failureMessage: "Failed to pause schedule for archived agent; continuing",
    });
  }

  async resumeForUnarchivedAgent(agentId: string): Promise<number> {
    return this.updateForAgent({
      agentId,
      applies: isPausedForArchivedAgent,
      change: resumeSchedule,
      failureMessage: "Failed to resume schedule for unarchived agent; continuing",
    });
  }

  private async updateForAgent(params: {
    agentId: string;
    applies: (schedule: StoredSchedule) => boolean;
    change: (schedule: StoredSchedule, now: Date) => StoredSchedule;
    failureMessage: string;
  }): Promise<number> {
    const { agentId, applies, change, failureMessage } = params;
    const now = this.now();
    const schedules = await this.store.list();
    // Match on the target only and check `applies` inside the update: a run
    // finishing at the same time can still change the status before the
    // serialized update gets its turn.
    const matches = schedules.filter(
      (schedule) => schedule.target.type === "agent" && schedule.target.agentId === agentId,
    );
    const results = await Promise.allSettled(
      matches.map(async (schedule) => {
        let changed = false;
        const updated = await this.store.update(schedule.id, (current) => {
          if (
            current.target.type !== "agent" ||
            current.target.agentId !== agentId ||
            !applies(current)
          ) {
            return current;
          }
          changed = true;
          return change(current, now);
        });
        requireSchedule(updated, schedule.id);
        return changed;
      }),
    );
    let count = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        count += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          failureMessage,
        );
      }
    }
    return count;
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new Error(`Schedule ${id} is already running`);
    }
    await this.runSchedule(schedule, this.now(), { manual: true });
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      if (schedule.status !== "active" || !schedule.nextRunAt) {
        continue;
      }
      if (this.runningScheduleIds.has(schedule.id)) {
        continue;
      }
      if (shouldCompleteSchedule(schedule, now)) {
        await this.completeScheduleIfDue(schedule.id, now);
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      await this.runSchedule(schedule, now);
    }
  }

  private async completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    await this.store.update(scheduleId, (current) => {
      let updated = { ...current };
      let dirty = false;

      const runningIndex = updated.runs.findIndex((run) => run.status === "running");
      if (runningIndex !== -1) {
        const runs = [...updated.runs];
        const runningRun = runs[runningIndex];
        if (
          updated.target.type === "new-agent" &&
          runningRun.workspaceId &&
          shouldArchiveScheduleRunWorkspace({
            agentId: runningRun.agentId,
            archiveOnFinish: updated.target.config.archiveOnFinish,
          })
        ) {
          interruptedWorkspaces.push({
            workspaceId: runningRun.workspaceId,
            agentId: runningRun.agentId,
            runId: runningRun.id,
          });
        }
        runs[runningIndex] = {
          ...runningRun,
          status: "failed",
          endedAt: now.toISOString(),
          error: "Daemon restarted before the scheduled run completed",
        };
        updated = { ...updated, runs };
        if (shouldCompleteSchedule(updated, now)) {
          updated = completeSchedule(updated, now);
        }
        dirty = true;
      }

      if (
        updated.status === "active" &&
        updated.nextRunAt &&
        new Date(updated.nextRunAt).getTime() <= now.getTime()
      ) {
        let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
        dirty = true;
      }

      if (dirty) {
        return { ...updated, updatedAt: now.toISOString() };
      }
      return current;
    });
    const interruptedWorkspace = interruptedWorkspaces[0];
    if (!interruptedWorkspace) {
      return;
    }
    try {
      await this.archiveWorkspace(interruptedWorkspace.workspaceId);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          agentId: interruptedWorkspace.agentId,
          workspaceId: interruptedWorkspace.workspaceId,
          scheduleId,
          runId: interruptedWorkspace.runId,
        },
        "Failed to archive interrupted scheduled workspace after daemon restart",
      );
    }
  }

  // Agent-target schedules whose agent was deleted while the daemon was down can
  // never fire successfully, so complete them on startup. Schedules of an archived
  // agent are paused for the archive, and ones paused for an archive that was
  // undone are resumed, as the archive callbacks would have done.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.store.update(scheduleId, async (schedule) => {
      if (schedule.target.type !== "agent" || schedule.status === "completed") {
        return schedule;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (!record) {
        return completeSchedule(schedule, now);
      }
      if (record.archivedAt) {
        return pauseScheduleForArchivedAgent(schedule, now);
      }
      // Unarchived while the resume could not be recorded (e.g. the daemon stopped).
      return isPausedForArchivedAgent(schedule) ? resumeSchedule(schedule, now) : schedule;
    });
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const manual = options?.manual === true;
    // Reserve before store I/O; persisted history cannot prove a run is still alive.
    this.runningScheduleIds.add(schedule.id);
    try {
      let runId: string;
      let scheduleWithRun: StoredSchedule;
      if (manual) {
        runId = randomUUID();
        const runningRun: ScheduleRun = {
          id: runId,
          scheduledFor: now.toISOString(),
          startedAt: now.toISOString(),
          endedAt: null,
          status: "running",
          agentId: null,
          output: null,
          error: null,
        };
        scheduleWithRun = await this.appendRunningRun(schedule.id, runningRun);
      } else {
        const claimed = await this.claimDueRun(schedule.id, now);
        if (!claimed) {
          return;
        }
        ({ schedule: scheduleWithRun, runId } = claimed);
      }

      try {
        const result = await this.runner(scheduleWithRun, runId);
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "succeeded",
          agentId: result.agentId,
          output: result.output,
          error: null,
          targetGone: false,
          targetArchived: false,
          manual,
        });
      } catch (error) {
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "failed",
          agentId: null,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          targetGone: error instanceof ScheduleTargetGoneError,
          targetArchived: error instanceof ScheduleTargetArchivedError,
          manual,
        });
      }
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async claimDueRun(
    scheduleId: string,
    now: Date,
  ): Promise<{ schedule: StoredSchedule; runId: string } | null> {
    let claimed: { schedule: StoredSchedule; runId: string } | null = null;
    const updatedSchedule = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        shouldCompleteSchedule(schedule, now) ||
        new Date(schedule.nextRunAt).getTime() > now.getTime()
      ) {
        return schedule;
      }

      const scheduledFor = schedule.nextRunAt;
      const isFinalRun =
        schedule.maxRuns !== null && countCompletedRuns(schedule) + 1 >= schedule.maxRuns;
      const nextRunAt = isFinalRun
        ? null
        : advanceNextRunAtPast(
            schedule.cadence,
            computeNextRunAt(schedule.cadence, new Date(scheduledFor)),
            now,
          ).toISOString();

      // Claim the due slot and advance its cursor in the same serialized update.
      // A tick can hold a stale list while another tick finishes this schedule.
      const runId = randomUUID();
      const runningRun: ScheduleRun = {
        id: runId,
        scheduledFor,
        startedAt: now.toISOString(),
        endedAt: null,
        status: "running",
        agentId: null,
        output: null,
        error: null,
      };
      const updated: StoredSchedule = {
        ...schedule,
        nextRunAt,
        updatedAt: now.toISOString(),
        runs: [...schedule.runs, runningRun],
      };
      claimed = { schedule: updated, runId };
      return updated;
    });
    requireSchedule(updatedSchedule, scheduleId);
    return claimed;
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: runningRun.startedAt,
      runs: [...schedule.runs, runningRun],
    }));
    return requireSchedule(updated, scheduleId);
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    targetGone: boolean;
    targetArchived: boolean;
    manual: boolean;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, async (schedule) => {
      // The agent can be unarchived between the failed run reading its record
      // and this update. Pausing then would outlast the unarchive's resume, so
      // read the record again and treat the run as an ordinary failure.
      const targetArchived =
        params.targetArchived && (await this.isTargetAgentArchived(schedule.target));
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              endedAt: now.toISOString(),
              agentId: params.agentId ?? run.agentId,
              output: params.output,
              error: params.error,
            }
          : run,
      );
      let updated: StoredSchedule = {
        ...schedule,
        runs: completedRuns,
        lastRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      if (params.targetGone) {
        // The target is permanently gone; retrying only burns the schedule down to
        // its expiry, so complete it now regardless of manual/scheduled origin.
        updated = completeSchedule(updated, now);
      } else if (targetArchived) {
        // The target is archived, which can be undone: wait for unarchive instead
        // of retrying, unless this run already used up the schedule.
        updated =
          !params.manual && shouldCompleteSchedule(updated, now)
            ? completeSchedule(updated, now)
            : pauseScheduleForArchivedAgent(updated, now);
      } else if (updated.status === "completed") {
        // Completed concurrently; record the run outcome but leave the schedule
        // terminal — don't advance.
      } else if (params.manual) {
        // Manual one-shot runs do not advance the cadence or recompute completion.
      } else if (shouldCompleteSchedule(updated, now)) {
        updated = completeSchedule(updated, now);
      } else if (updated.status === "paused") {
        updated = {
          ...updated,
          nextRunAt: null,
        };
      } else {
        // A final slot has no successor until its run limit is raised or cleared.
        // Every runner invocation has a recorded run with this id.
        const finishedRun = completedRuns.find((run) => run.id === params.runId)!;
        const nextRunAt = updated.nextRunAt
          ? new Date(updated.nextRunAt)
          : computeNextRunAt(updated.cadence, new Date(finishedRun.scheduledFor));
        // Move an overdue cursor past a long run without advancing a future one twice.
        updated = {
          ...updated,
          nextRunAt: advanceNextRunAtPast(updated.cadence, nextRunAt, now).toISOString(),
        };
      }

      return updated;
    });
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async isTargetAgentArchived(target: ScheduleTarget): Promise<boolean> {
    if (target.type !== "agent") {
      return false;
    }
    const record = await this.agentStorage.get(target.agentId);
    return Boolean(record?.archivedAt);
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? {
              ...run,
              workspaceId: params.workspaceId,
              agentId: params.agentId,
            }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult> {
    if (schedule.target.type === "agent") {
      const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (!record) {
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} no longer exists`);
      }
      if (record.archivedAt) {
        throw new ScheduleTargetArchivedError(`Agent ${schedule.target.agentId} is archived`);
      }

      const agent = await ensureAgentLoaded(schedule.target.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (this.agentManager.hasInFlightRun(agent.id)) {
        throw new Error(`Agent ${agent.id} already has an active run`);
      }
      await startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, {
        replaceRunning: true,
        activeTurnBehavior: "steer",
      });
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: null,
          timelineText: "",
          finalText: waitResult.lastMessage ?? "",
        }),
      };
    }

    const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
    if (!config) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    await this.assertNewAgentCwdDirectory(config.cwd);
    let workspace: PersistedWorkspaceRecord | null = null;
    let agentId: string | null = null;
    try {
      workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId: null,
      });
      const runConfig = { ...config, cwd: workspace.cwd };
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatScheduleProviderModel(runConfig),
        config: buildScheduleAgentConfig(runConfig),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: resolveScheduleAgentTitle(config, schedule.prompt),
        labels: {
          "paseo.schedule-id": schedule.id,
          "paseo.schedule-run": runId,
        },
        mode: config.modeId,
        thinking: config.thinkingOptionId,
        features: config.featureValues,
        unattended: true,
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      const agent = created.snapshot;
      agentId = agent.id;
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId,
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const result = await this.agentManager.runAgent(agent.id, schedule.prompt);
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
      });
      if (result.canceled) {
        throw new Error(`Scheduled agent ${agent.id} was canceled`);
      }
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: waitResult.lastMessage ?? null,
          timelineText,
          finalText: result.finalText,
        }),
      };
    } finally {
      if (
        workspace &&
        shouldArchiveScheduleRunWorkspace({ agentId, archiveOnFinish: config.archiveOnFinish })
      ) {
        try {
          await this.archiveWorkspace(workspace.workspaceId);
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              agentId,
              workspaceId: workspace.workspaceId,
              scheduleId: schedule.id,
              runId,
            },
            "Failed to archive scheduled workspace after run",
          );
        }
      }
    }
  }

  private async createScheduleRunWorkspace(
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createDirectoryWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private async assertNewAgentCwdDirectory(cwd: string): Promise<void> {
    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }
}

function buildScheduleAgentConfig(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    providerOptions: config.providerOptions,
    featureValues: config.featureValues,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveScheduleAgentTitle(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  prompt: string,
): string {
  return (
    resolveCreateAgentTitles({
      configTitle: config.title,
      initialPrompt: prompt,
    }).provisionalTitle ?? ""
  );
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
