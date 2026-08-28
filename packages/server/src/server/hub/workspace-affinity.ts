import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type pino from "pino";
import { z } from "zod";
import type {
  CreateAgentWorktreeTarget,
  HubExecutionWorkspaceAffinity,
} from "@getpaseo/protocol/messages";
import { CreateAgentWorktreeTargetSchema } from "@getpaseo/protocol/messages";

import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const FILE_NAME = "workspace-affinities.json";
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const ARCHIVE_RETRY_DELAY_MS = 60_000;

const WorkspaceAffinityTargetSchema = z
  .object({
    cwd: z.string().min(1),
    worktree: CreateAgentWorktreeTargetSchema.optional(),
    autoArchive: z.boolean(),
  })
  .strict();

const PersistedWorkspaceAffinitySchema = z
  .object({
    target: WorkspaceAffinityTargetSchema,
    workspaceId: z.string().min(1).nullable(),
    cwd: z.string().min(1).nullable(),
    retainUntil: z.string().datetime(),
  })
  .strict();

const PersistedWorkspaceAffinitiesSchema = z
  .object({
    version: z.literal(1),
    affinities: z.record(z.string(), PersistedWorkspaceAffinitySchema),
  })
  .strict();

type WorkspaceAffinityTarget = z.infer<typeof WorkspaceAffinityTargetSchema>;
type PersistedWorkspaceAffinity = z.infer<typeof PersistedWorkspaceAffinitySchema>;
type PersistedWorkspaceAffinities = z.infer<typeof PersistedWorkspaceAffinitiesSchema>;

export interface ScheduledWorkspaceAffinityTask {
  cancel(): void;
}

export interface WorkspaceAffinityClock {
  now(): Date;
  schedule(delayMs: number, task: () => void): ScheduledWorkspaceAffinityTask;
}

const systemClock: WorkspaceAffinityClock = {
  now: () => new Date(),
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface WorkspaceAffinityPlacement {
  cwd: string;
  workspaceId?: string;
  worktree?: CreateAgentWorktreeTarget;
}

interface WorkspaceAffinityCreateResult<Value> {
  value: Value;
  workspaceId: string;
  cwd: string;
}

export interface WorkspaceAffinityManagerOptions {
  paseoHome: string;
  daemonId: string;
  agentStorage: Pick<AgentStorage, "list" | "listByWorkspace">;
  ensureWorkspace: (workspaceId: string) => Promise<void>;
  archiveWorkspace: (workspaceId: string, requestId: string) => Promise<unknown>;
  logger: Pick<pino.Logger, "error" | "warn">;
  clock?: WorkspaceAffinityClock;
}

/**
 * Owns the daemon-local mapping from a Hub-provided opaque key to a workspace.
 *
 * The raw key is never written to disk. A persisted mapping starts before the first create so an
 * agent record carrying the same hash can repair an interrupted first creation after restart.
 */
export class WorkspaceAffinityManager {
  private readonly filePath: string;
  private readonly clock: WorkspaceAffinityClock;
  private state: PersistedWorkspaceAffinities;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ScheduledWorkspaceAffinityTask>();
  private unreadableState: Error | null = null;
  private disposed = false;

  constructor(private readonly options: WorkspaceAffinityManagerOptions) {
    this.filePath = path.join(options.paseoHome, "hub-executions", options.daemonId, FILE_NAME);
    this.clock = options.clock ?? systemClock;
    this.state = this.load();
    for (const affinityId of Object.keys(this.state.affinities)) this.arm(affinityId);
  }

  affinityId(key: string): string {
    return workspaceAffinityId(key);
  }

  async create<Value>(input: {
    affinity: HubExecutionWorkspaceAffinity;
    cwd: string;
    worktree?: CreateAgentWorktreeTarget;
    create: (
      placement: WorkspaceAffinityPlacement,
    ) => Promise<WorkspaceAffinityCreateResult<Value>>;
  }): Promise<Value> {
    this.requireUsable();
    const affinityId = this.affinityId(input.affinity.key);
    const target = affinityTarget(input);
    return this.withAffinity(affinityId, async () => {
      let persisted: PersistedWorkspaceAffinity | undefined = this.state.affinities[affinityId];
      if (persisted) {
        assertMatchingTarget(affinityId, persisted.target, target);
        if (extendRetention(persisted, input.affinity.retainUntil)) this.persist();
        const placement = await this.resolvePlacement(affinityId, persisted);
        if (placement) {
          this.arm(affinityId);
          await this.options.ensureWorkspace(placement.workspaceId!);
          const created = await input.create(placement);
          if (created.workspaceId !== placement.workspaceId || created.cwd !== placement.cwd) {
            throw new Error(`Workspace affinity ${affinityId} create escaped its bound workspace`);
          }
          return created.value;
        }
        // The provisional mapping survived an interrupted failed create, but no owned agent
        // establishes a workspace to recover. A new create may safely replace it.
        delete this.state.affinities[affinityId];
        this.persist();
        persisted = undefined;
      }

      persisted = {
        target,
        workspaceId: null,
        cwd: null,
        retainUntil: input.affinity.retainUntil,
      };
      this.state.affinities[affinityId] = persisted;
      this.persist();

      let created: WorkspaceAffinityCreateResult<Value>;
      try {
        created = await input.create({
          cwd: target.cwd,
          ...(target.worktree === undefined ? {} : { worktree: structuredClone(target.worktree) }),
        });
      } catch (error) {
        if (this.state.affinities[affinityId] === persisted && persisted.workspaceId === null) {
          delete this.state.affinities[affinityId];
          this.persist();
        }
        throw error;
      }
      if (!created.workspaceId || !created.cwd) {
        throw new Error("Workspace affinity create returned no workspace placement");
      }
      persisted.workspaceId = created.workspaceId;
      persisted.cwd = created.cwd;
      this.persist();
      this.arm(affinityId);
      return created.value;
    });
  }

  /** Repairs or recreates the durable mapping before an existing affinity-owned agent is replayed. */
  async bindExisting(input: {
    affinity: HubExecutionWorkspaceAffinity;
    cwd: string;
    worktree?: CreateAgentWorktreeTarget;
    workspaceId: string;
    workspaceCwd: string;
  }): Promise<void> {
    this.requireUsable();
    const affinityId = this.affinityId(input.affinity.key);
    const target = affinityTarget(input);
    await this.withAffinity(affinityId, async () => {
      let persisted = this.state.affinities[affinityId];
      if (persisted) {
        assertMatchingTarget(affinityId, persisted.target, target);
        if (persisted.workspaceId && persisted.workspaceId !== input.workspaceId) {
          throw new Error(`Workspace affinity ${affinityId} resolves to multiple workspaces`);
        }
        if (persisted.cwd && persisted.cwd !== input.workspaceCwd) {
          throw new Error(`Workspace affinity ${affinityId} resolves to multiple workspace paths`);
        }
        extendRetention(persisted, input.affinity.retainUntil);
        persisted.workspaceId = input.workspaceId;
        persisted.cwd = input.workspaceCwd;
      } else {
        persisted = {
          target,
          workspaceId: input.workspaceId,
          cwd: input.workspaceCwd,
          retainUntil: input.affinity.retainUntil,
        };
        this.state.affinities[affinityId] = persisted;
      }
      this.persist();
      this.arm(affinityId);
      await this.options.ensureWorkspace(input.workspaceId);
    });
  }

  /** Called after an affinity-owned agent is archived. */
  async release(affinityId: string): Promise<void> {
    if (this.disposed) return;
    await this.withAffinity(affinityId, async () => {
      try {
        if (!(await this.archiveIfDue(affinityId))) this.armRetry(affinityId);
      } catch (error) {
        this.options.logger.warn(
          { err: error, affinityId },
          "Failed to archive a released Hub workspace affinity",
        );
        this.armRetry(affinityId);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  private load(): PersistedWorkspaceAffinities {
    if (!existsSync(this.filePath)) return { version: 1, affinities: {} };
    try {
      const loaded = PersistedWorkspaceAffinitiesSchema.parse(
        JSON.parse(readFileSync(this.filePath, "utf8")),
      );
      ensurePrivateFile(this.filePath);
      return loaded;
    } catch (error) {
      this.unreadableState = error instanceof Error ? error : new Error(String(error));
      this.options.logger.error(
        { err: error, filePath: this.filePath },
        "Hub workspace affinity state is unreadable",
      );
      return { version: 1, affinities: {} };
    }
  }

  private persist(): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private async resolvePlacement(
    affinityId: string,
    persisted: PersistedWorkspaceAffinity,
  ): Promise<WorkspaceAffinityPlacement | null> {
    if (persisted.workspaceId && persisted.cwd) {
      return { cwd: persisted.cwd, workspaceId: persisted.workspaceId };
    }
    const records = (await this.options.agentStorage.list()).filter((record) =>
      isAffinityOwned(record, this.options.daemonId, affinityId),
    );
    const placements = records.flatMap((record) =>
      record.workspaceId ? [{ workspaceId: record.workspaceId, cwd: record.cwd }] : [],
    );
    const uniqueWorkspaceIds = new Set(placements.map((placement) => placement.workspaceId));
    if (uniqueWorkspaceIds.size === 0) return null;
    if (uniqueWorkspaceIds.size !== 1) {
      throw new Error(`Workspace affinity ${affinityId} resolves to multiple workspaces`);
    }
    const placement = placements[0]!;
    persisted.workspaceId = placement.workspaceId;
    persisted.cwd = placement.cwd;
    this.persist();
    return placement;
  }

  private arm(affinityId: string): void {
    const persisted = this.state.affinities[affinityId];
    if (!persisted) return;
    const deadline = parseDeadline(persisted.retainUntil);
    const delayMs = Math.min(
      Math.max(0, deadline.getTime() - this.clock.now().getTime()),
      MAX_TIMER_DELAY_MS,
    );
    this.schedule(affinityId, delayMs);
  }

  private armRetry(affinityId: string): void {
    this.schedule(affinityId, ARCHIVE_RETRY_DELAY_MS);
  }

  private schedule(affinityId: string, delayMs: number): void {
    this.timers.get(affinityId)?.cancel();
    this.timers.delete(affinityId);
    if (this.disposed) return;
    const persisted = this.state.affinities[affinityId];
    if (!persisted?.target.autoArchive || !persisted.workspaceId) return;
    const timer = this.clock.schedule(delayMs, () => {
      this.timers.delete(affinityId);
      void this.withAffinity(affinityId, async () => {
        try {
          if (!(await this.archiveIfDue(affinityId))) this.armRetry(affinityId);
        } catch (error) {
          this.options.logger.warn(
            { err: error, affinityId },
            "Failed to archive an expired Hub workspace affinity",
          );
          this.armRetry(affinityId);
        }
      });
    });
    this.timers.set(affinityId, timer);
  }

  private async archiveIfDue(affinityId: string): Promise<boolean> {
    const persisted = this.state.affinities[affinityId];
    if (!persisted?.target.autoArchive || this.disposed) return true;
    if (parseDeadline(persisted.retainUntil).getTime() > this.clock.now().getTime()) {
      this.arm(affinityId);
      return true;
    }
    const placement = await this.resolvePlacement(affinityId, persisted);
    if (!placement?.workspaceId) return true;
    const records = await this.options.agentStorage.listByWorkspace(placement.workspaceId);
    const protectedAgent = records.find(
      (record) => !record.archivedAt && !isAffinityOwned(record, this.options.daemonId, affinityId),
    );
    if (protectedAgent) {
      this.options.logger.warn(
        { affinityId, workspaceId: placement.workspaceId, agentId: protectedAgent.id },
        "Skipped Hub workspace affinity archive because the workspace has an unrelated live agent",
      );
      return false;
    }
    await this.options.archiveWorkspace(
      placement.workspaceId,
      `workspace-affinity:${affinityId}:${parseDeadline(persisted.retainUntil).getTime()}:${randomUUID()}`,
    );
    return true;
  }

  private requireUsable(): void {
    if (this.disposed) throw new Error("Workspace affinity manager is no longer active");
    if (this.unreadableState) {
      throw new Error(`Workspace affinity state is unreadable: ${this.unreadableState.message}`);
    }
  }

  private async withAffinity<Value>(
    affinityId: string,
    action: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.tails.get(affinityId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(affinityId, tail);
    void tail.then(() => {
      if (this.tails.get(affinityId) === tail) this.tails.delete(affinityId);
      return undefined;
    });
    return result;
  }
}

/**
 * Keeps affinity retention alive at daemon scope rather than relationship-authority scope.
 * Persisted daemon ids are discovered on startup so a disconnected or revoked relationship can
 * still finish its previously acknowledged auto-archive leases.
 */
export class WorkspaceAffinityManagerPool {
  private readonly managers = new Map<string, WorkspaceAffinityManager>();
  private started = false;
  private disposed = false;

  constructor(private readonly options: Omit<WorkspaceAffinityManagerOptions, "daemonId">) {}

  start(): void {
    this.requireActive();
    if (this.started) return;
    this.started = true;
    const executionsDirectory = path.join(this.options.paseoHome, "hub-executions");
    if (!existsSync(executionsDirectory)) return;
    for (const entry of readdirSync(executionsDirectory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(path.join(executionsDirectory, entry.name, FILE_NAME))
      ) {
        this.forDaemon(entry.name);
      }
    }
  }

  forDaemon(daemonId: string): WorkspaceAffinityManager {
    this.requireActive();
    const existing = this.managers.get(daemonId);
    if (existing) return existing;
    const manager = new WorkspaceAffinityManager({ ...this.options, daemonId });
    this.managers.set(daemonId, manager);
    return manager;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const manager of this.managers.values()) manager.dispose();
    this.managers.clear();
  }

  private requireActive(): void {
    if (this.disposed) throw new Error("Workspace affinity manager pool is no longer active");
  }
}

export function workspaceAffinityId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function affinityTarget(input: {
  affinity: HubExecutionWorkspaceAffinity;
  cwd: string;
  worktree?: CreateAgentWorktreeTarget;
}): WorkspaceAffinityTarget {
  return {
    cwd: input.cwd,
    ...(input.worktree === undefined ? {} : { worktree: structuredClone(input.worktree) }),
    autoArchive: input.affinity.autoArchive,
  };
}

function assertMatchingTarget(
  affinityId: string,
  existing: WorkspaceAffinityTarget,
  requested: WorkspaceAffinityTarget,
): void {
  if (!isDeepStrictEqual(existing, requested)) {
    throw new Error(
      `Workspace affinity ${affinityId} is already bound to a different cwd, worktree, or auto-archive policy`,
    );
  }
}

function extendRetention(persisted: PersistedWorkspaceAffinity, requested: string): boolean {
  if (parseDeadline(requested).getTime() <= parseDeadline(persisted.retainUntil).getTime()) {
    return false;
  }
  persisted.retainUntil = requested;
  return true;
}

function parseDeadline(value: string): Date {
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime()))
    throw new Error(`Invalid workspace affinity deadline: ${value}`);
  return deadline;
}

function isAffinityOwned(record: StoredAgentRecord, daemonId: string, affinityId: string): boolean {
  const owner = record.owner;
  return (
    owner?.kind === "daemon" &&
    owner.daemonId === daemonId &&
    owner.workspaceAffinityId === affinityId
  );
}
