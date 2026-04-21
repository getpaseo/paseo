import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentPromptInput, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  StoredSchedule,
} from "./types.js";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
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

function buildAgentPrompt(text: string): AgentPromptInput {
  return text;
}

export interface ScheduleServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  now?: () => Date;
  runner?: (schedule: StoredSchedule) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly now: () => Date;
  private readonly runner: (schedule: StoredSchedule) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"));
    this.logger = options.logger.child({ module: "schedule-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule) => this.executeSchedule(schedule));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
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
    const now = this.now();
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    const schedule = await this.store.create({
      name: trimOptionalName(input.name),
      prompt,
      cadence: input.cadence,
      target: input.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: computeNextRunAt(input.cadence, now).toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
    });
    return schedule;
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
  }

  async resume(id: string): Promise<StoredSchedule> {
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
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
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
        await this.store.put(completeSchedule(schedule, now));
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      await this.runSchedule(schedule, now);
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    for (const schedule of schedules) {
      let updated = { ...schedule };
      let dirty = false;

      // Mark any in-flight runs as failed
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

      // Advance stale nextRunAt for active schedules
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
    }
  }

  private async runSchedule(schedule: StoredSchedule, now: Date): Promise<void> {
    this.runningScheduleIds.add(schedule.id);
    const runId = randomUUID();
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor: schedule.nextRunAt ?? now.toISOString(),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };
    const scheduleWithRun = {
      ...schedule,
      updatedAt: now.toISOString(),
      runs: [...schedule.runs, runningRun],
    };
    await this.store.put(scheduleWithRun);

    try {
      const result = await this.runner(scheduleWithRun);
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "succeeded",
        agentId: result.agentId,
        output: result.output,
        error: null,
      });
    } catch (error) {
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "failed",
        agentId: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
  }): Promise<void> {
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

    if (shouldCompleteSchedule(updated, now)) {
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
  }

  private async executeSchedule(schedule: StoredSchedule): Promise<ScheduleExecutionResult> {
    if (schedule.target.type === "agent") {
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record?.archivedAt) {
        throw new Error(`Agent ${schedule.target.agentId} is archived`);
      }

      const agent = await ensureAgentLoaded(schedule.target.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
      if (this.agentManager.hasInFlightRun(agent.id)) {
        throw new Error(`Agent ${agent.id} already has an active run`);
      }
      this.agentManager.recordUserMessage(agent.id, schedule.prompt, { emitState: false });
      const result = await this.agentManager.runAgent(agent.id, buildAgentPrompt(schedule.prompt));
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

    const config: AgentSessionConfig = {
      provider: schedule.target.config.provider,
      cwd: schedule.target.config.cwd,
      modeId: schedule.target.config.modeId,
      model: schedule.target.config.model,
      thinkingOptionId: schedule.target.config.thinkingOptionId,
      title: schedule.target.config.title,
      approvalPolicy: schedule.target.config.approvalPolicy,
      sandboxMode: schedule.target.config.sandboxMode,
      networkAccess: schedule.target.config.networkAccess,
      webSearch: schedule.target.config.webSearch,
      extra: schedule.target.config.extra,
      systemPrompt: schedule.target.config.systemPrompt,
      mcpServers: schedule.target.config.mcpServers as AgentSessionConfig["mcpServers"],
    };
    const labels = {
      "paseo.schedule-id": schedule.id,
      "paseo.schedule-run": randomUUID(),
    };
    const agent = await this.agentManager.createAgent(config, undefined, { labels });
    this.agentManager.recordUserMessage(agent.id, schedule.prompt, { emitState: false });
    const result = await this.agentManager.runAgent(agent.id, buildAgentPrompt(schedule.prompt));
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
}
