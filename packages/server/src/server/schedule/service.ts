import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import {
  type BoundCreateAgentCommand,
  type EnsureWorkspaceForCreate,
  formatProviderModel,
} from "../agent/create-agent/create.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
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

const SCHEDULE_TICK_INTERVAL_MS = 1000;

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
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

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

// Sort object keys recursively so two structurally-equal configs serialize
// identically regardless of key order. Stored configs come back from disk in Zod
// schema order while incoming configs keep their construction order, so a plain
// JSON.stringify comparison would wrongly treat identical targets as different.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return value;
}

function scheduleTargetsEqual(a: ScheduleTarget, b: ScheduleTarget): boolean {
  if (a.type === "agent" && b.type === "agent") {
    return a.agentId === b.agentId;
  }
  if (a.type === "new-agent" && b.type === "new-agent") {
    return JSON.stringify(canonicalize(a.config)) === JSON.stringify(canonicalize(b.config));
  }
  return false;
}

function scheduleTargetsEqualForCreateOrReplace(
  existing: ScheduleTarget,
  incoming: ScheduleTarget,
): boolean {
  if (existing.type !== "new-agent" || incoming.type !== "new-agent") {
    return scheduleTargetsEqual(existing, incoming);
  }
  const incomingConfig =
    incoming.config.workspaceId || !existing.config.workspaceId
      ? incoming.config
      : { ...incoming.config, workspaceId: existing.config.workspaceId };
  return (
    JSON.stringify(canonicalize(existing.config)) === JSON.stringify(canonicalize(incomingConfig))
  );
}

function carryExistingWorkspaceStamp(
  existing: ScheduleTarget,
  incoming: ScheduleTarget,
): ScheduleTarget {
  if (
    existing.type !== "new-agent" ||
    incoming.type !== "new-agent" ||
    incoming.config.workspaceId ||
    !existing.config.workspaceId
  ) {
    return incoming;
  }
  return {
    ...incoming,
    config: {
      ...incoming.config,
      workspaceId: existing.config.workspaceId,
    },
  };
}

function createOrReplaceMutationKey(name: string, target: ScheduleTarget): string {
  return JSON.stringify(canonicalize({ name, target }));
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
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
  AgentManager,
  | "archiveAgent"
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hasInFlightRun"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
  | "runAgent"
  | "waitForAgentEvent"
>;

type ScheduleWorkspaceRegistry = Pick<WorkspaceRegistry, "get">;

export interface ScheduleServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  ensureWorkspaceForCreate: EnsureWorkspaceForCreate;
  workspaceRegistry: ScheduleWorkspaceRegistry;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly ensureWorkspaceForCreate: EnsureWorkspaceForCreate;
  private readonly workspaceRegistry: ScheduleWorkspaceRegistry;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private readonly scheduleMutationPromises = new Map<string, Promise<unknown>>();
  private readonly createOrReplaceMutationPromises = new Map<string, Promise<unknown>>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"));
    this.logger = options.logger.child({ module: "schedule-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.ensureWorkspaceForCreate = options.ensureWorkspaceForCreate;
    this.workspaceRegistry = options.workspaceRegistry;
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
    const target = await this.stampNewAgentWorkspace(input.target, input.prompt);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return this.store.create({
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
    });
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  async createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    if (name === null) {
      const target = await this.stampNewAgentWorkspace(input.target, input.prompt);
      return this.createScheduleRecord(input, { name, prompt, target });
    }

    return this.serializeCreateOrReplaceMutation(
      createOrReplaceMutationKey(name, input.target),
      async () => this.createOrReplaceWithName(input, { name, prompt }),
    );
  }

  private async createOrReplaceWithName(
    input: CreateScheduleInput,
    fields: { name: string; prompt: string },
  ): Promise<StoredSchedule> {
    const existing = (await this.store.list()).find(
      (schedule) =>
        schedule.status !== "completed" &&
        trimOptionalName(schedule.name) === fields.name &&
        scheduleTargetsEqualForCreateOrReplace(schedule.target, input.target),
    );
    if (!existing) {
      const target = await this.stampNewAgentWorkspace(input.target, input.prompt);
      return this.createScheduleRecord(input, { ...fields, target });
    }

    return this.serializeScheduleMutation(existing.id, async () => {
      const current = await this.inspect(existing.id);
      const now = this.now();
      const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
      const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
      const target = await this.stampNewAgentWorkspace(
        carryExistingWorkspaceStamp(current.target, input.target),
        input.prompt,
      );
      const replaced: StoredSchedule = {
        ...current,
        name: fields.name,
        prompt: fields.prompt,
        cadence: input.cadence,
        target,
        status: "active",
        pausedAt: null,
        nextRunAt: nextRunAt.toISOString(),
        expiresAt: input.expiresAt ?? null,
        maxRuns: normalizeMaxRuns(input.maxRuns),
        updatedAt: now.toISOString(),
      };
      await this.store.put(replaced);
      return replaced;
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
    return this.serializeScheduleMutation(id, async () => {
      const schedule = await this.inspect(id);
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        return schedule;
      }
      const now = this.now();
      const paused = {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.store.put(paused);
      return paused;
    });
  }

  async resume(id: string): Promise<StoredSchedule> {
    return this.serializeScheduleMutation(id, async () => {
      const schedule = await this.inspect(id);
      if (schedule.status === "completed") {
        throw new Error(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      const now = this.now();
      const resumed = {
        ...schedule,
        status: "active" as const,
        pausedAt: null,
        nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.store.put(resumed);
      return resumed;
    });
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    return this.serializeScheduleMutation(input.id, async () => {
      const schedule = await this.inspect(input.id);
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        validateScheduleCadence(input.cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(input.cadence, now).toISOString() : null;
        updated = { ...updated, cadence: input.cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        updated = {
          ...updated,
          target: await this.stampNewAgentWorkspace(patchedTarget, updated.prompt),
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      updated = {
        ...updated,
        target: await this.stampNewAgentWorkspace(updated.target, updated.prompt),
      };
      updated = { ...updated, updatedAt: now.toISOString() };
      await this.store.put(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serializeScheduleMutation(id, async () => {
      await this.store.delete(id);
    });
  }

  async completeForAgent(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.store.list();
    const matches = schedules.filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    );
    const results = await Promise.allSettled(
      matches.map((schedule) => this.completeScheduleForAgent(schedule.id, agentId, now)),
    );
    let completed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        completed += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          "Failed to complete schedule for archived agent; continuing",
        );
      }
    }
    return completed;
  }

  private async completeScheduleForAgent(
    scheduleId: string,
    agentId: string,
    now: Date,
  ): Promise<boolean> {
    return this.serializeScheduleMutation(scheduleId, async () => {
      const schedule = await this.inspect(scheduleId);
      if (
        schedule.target.type !== "agent" ||
        schedule.target.agentId !== agentId ||
        schedule.status === "completed"
      ) {
        return false;
      }
      await this.store.put(completeSchedule(schedule, now));
      return true;
    });
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
    await this.serializeScheduleMutation(scheduleId, async () => {
      const schedule = await this.inspect(scheduleId);
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return;
      }
      await this.store.put(completeSchedule(schedule, now));
    });
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.serializeScheduleMutation(scheduleId, async () => {
      const current = await this.store.get(scheduleId);
      if (!current) {
        return;
      }
      let updated = { ...current };
      let dirty = false;

      const runningIndex = updated.runs.findIndex((run) => run.status === "running");
      if (runningIndex !== -1) {
        const runs = [...updated.runs];
        runs[runningIndex] = {
          ...runs[runningIndex],
          status: "failed",
          endedAt: now.toISOString(),
          error: "Daemon restarted before the scheduled run completed",
        };
        updated = { ...updated, runs };
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
        updated = { ...updated, updatedAt: now.toISOString() };
        await this.store.put(updated);
      }
    });
  }

  // Orphaned agent-target schedules (agent deleted while the daemon was down, or
  // archived before completeForAgent existed) can never fire successfully. Complete
  // them on startup so they stop ticking and surface as ended in the UI.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.serializeScheduleMutation(scheduleId, async () => {
      const schedule = await this.store.get(scheduleId);
      if (!schedule || schedule.target.type !== "agent" || schedule.status === "completed") {
        return;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record && !record.archivedAt) {
        return;
      }
      await this.store.put(completeSchedule(schedule, now));
    });
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const manual = options?.manual === true;
    this.runningScheduleIds.add(schedule.id);
    const runId = randomUUID();
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor: manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString()),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };
    const scheduleWithRun = await this.appendRunningRun(schedule.id, runningRun);

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
        manual,
      });
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    return this.serializeScheduleMutation(scheduleId, async () => {
      const schedule = await this.inspect(scheduleId);
      const updated = {
        ...schedule,
        updatedAt: runningRun.startedAt,
        runs: [...schedule.runs, runningRun],
      };
      await this.store.put(updated);
      return updated;
    });
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    targetGone: boolean;
    manual: boolean;
  }): Promise<void> {
    await this.serializeScheduleMutation(params.scheduleId, async () => {
      const schedule = await this.inspect(params.scheduleId);
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              endedAt: now.toISOString(),
              agentId: params.agentId,
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
      } else if (updated.status === "completed") {
        // Completed concurrently (e.g. the target agent was archived mid-run);
        // record the run outcome but leave the schedule terminal — don't advance.
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
        const after = new Date(schedule.nextRunAt ?? now.toISOString());
        let nextRunAt = computeNextRunAt(updated.cadence, after);
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = {
          ...updated,
          nextRunAt: nextRunAt.toISOString(),
        };
      }

      await this.store.put(updated);
    });
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
        throw new ScheduleTargetGoneError(`Agent ${schedule.target.agentId} is archived`);
      }

      const agent = await ensureAgentLoaded(schedule.target.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (this.agentManager.hasInFlightRun(agent.id)) {
        throw new Error(`Agent ${agent.id} already has an active run`);
      }
      const result = await this.agentManager.runAgent(agent.id, wrappedPrompt);
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: null,
          timelineText,
          finalText: result.finalText,
        }),
      };
    }

    const targetConfig = schedule.target.config;
    await this.assertNewAgentCwdExists(targetConfig.cwd);
    const stampedSchedule = await this.ensureScheduleWorkspaceStamped(schedule);
    const stampedConfig =
      stampedSchedule.target.type === "new-agent" ? stampedSchedule.target.config : null;
    if (!stampedConfig) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    const created = await this.createAgent({
      kind: "mcp",
      provider: formatScheduleProviderModel(stampedConfig),
      config: buildScheduleAgentConfig(stampedConfig),
      cwd: stampedConfig.cwd,
      workspaceId: stampedConfig.workspaceId,
      title: stampedConfig.title ?? "",
      initialPrompt: stampedSchedule.prompt,
      labels: {
        "paseo.schedule-id": stampedSchedule.id,
        "paseo.schedule-run": runId,
      },
      mode: stampedConfig.modeId,
      thinking: stampedConfig.thinkingOptionId,
      features: stampedConfig.featureValues,
      unattended: true,
      promptFailure: "return-error",
      background: true,
      notifyOnFinish: false,
    });
    const agent = created.snapshot;
    try {
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const result = await this.agentManager.waitForAgentEvent(agent.id, { waitForActive: true });
      if (result.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (result.status === "error") {
        throw new Error(result.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      await this.agentManager.archiveAgent(agent.id);
      return {
        agentId: agent.id,
        output: result.lastMessage?.trim() ? result.lastMessage.trim() : null,
      };
    } catch (error) {
      try {
        await this.agentManager.archiveAgent(agent.id);
      } catch (archiveError) {
        this.logger.warn(
          { err: archiveError, agentId: agent.id, scheduleId: schedule.id, runId },
          "Failed to archive scheduled agent after failed run",
        );
      }
      throw error;
    }
  }

  private async serializeScheduleMutation<T>(
    scheduleId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.scheduleMutationPromises, scheduleId, mutation);
  }

  private async serializeCreateOrReplaceMutation<T>(
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.createOrReplaceMutationPromises, key, mutation);
  }

  private async serializeMutation<T>(
    promises: Map<string, Promise<unknown>>,
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = promises.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    promises.set(key, next);
    try {
      return await next;
    } finally {
      if (promises.get(key) === next) {
        promises.delete(key);
      }
    }
  }

  private async assertNewAgentCwdExists(cwd: string): Promise<void> {
    try {
      await stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }

  private async createWorkspaceStampedTarget(
    target: Extract<ScheduleTarget, { type: "new-agent" }>,
    prompt: string,
  ): Promise<ScheduleTarget> {
    const workspaceId = await this.ensureWorkspaceForCreate(target.config.cwd, { prompt });
    return {
      ...target,
      config: {
        ...target.config,
        workspaceId,
      },
    };
  }

  private async hasActiveWorkspaceStamp(workspaceId: string): Promise<boolean> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    return Boolean(workspace && !workspace.archivedAt);
  }

  private async stampNewAgentWorkspace(
    target: ScheduleTarget,
    prompt: string,
  ): Promise<ScheduleTarget> {
    if (target.type !== "new-agent" || target.config.workspaceId) {
      return target;
    }
    return this.createWorkspaceStampedTarget(target, prompt);
  }

  private async ensureScheduleWorkspaceStamped(schedule: StoredSchedule): Promise<StoredSchedule> {
    if (schedule.target.type !== "new-agent") {
      return schedule;
    }
    return this.serializeScheduleMutation(schedule.id, async () => {
      const latest = (await this.store.get(schedule.id)) ?? schedule;
      if (latest.target.type !== "new-agent") {
        return latest;
      }
      const stampedWorkspaceId = latest.target.config.workspaceId;
      if (stampedWorkspaceId && (await this.hasActiveWorkspaceStamp(stampedWorkspaceId))) {
        return latest;
      }

      await this.assertNewAgentCwdExists(latest.target.config.cwd);
      const target = await this.createWorkspaceStampedTarget(latest.target, latest.prompt);
      const stamped = {
        ...latest,
        target,
        updatedAt: this.now().toISOString(),
      };
      await this.store.put(stamped);
      return stamped;
    });
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
    approvalPolicy: config.approvalPolicy,
    sandboxMode: config.sandboxMode,
    networkAccess: config.networkAccess,
    webSearch: config.webSearch,
    featureValues: config.featureValues,
    extra: config.extra,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
