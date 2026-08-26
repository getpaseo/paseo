import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

export const WATCHDOG_MAX_STREAM_BYTES = 8 * 1024 * 1024;

const WATCHDOG_JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const WatchdogStreamStatsSchema = z.object({
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const WatchdogWorkerLockSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

const WatchdogResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  finishedAt: z.string(),
  terminationReason: z.enum(["cancelled", "timeout"]).optional(),
  stdout: WatchdogStreamStatsSchema.optional(),
  stderr: WatchdogStreamStatsSchema.optional(),
});

type WatchdogWorkerLock = z.infer<typeof WatchdogWorkerLockSchema>;
type WatchdogWorkerLockRead =
  | { status: "missing" }
  | { status: "valid"; lock: WatchdogWorkerLock }
  | { status: "corrupt" };

const StoredWatchdogJobRawSchema = z.object({
  id: z.string().regex(WATCHDOG_JOB_ID_PATTERN),
  name: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  status: z.enum([
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  deliveryStatus: z.enum(["pending", "delivered"]).optional(),
  workerPid: z.number().int().positive().nullable().optional(),
  result: WatchdogResultSchema.nullable().optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  cancelRequestedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deliveredAt: z.string().nullable().optional(),
});

export type WatchdogResult = z.infer<typeof WatchdogResultSchema>;
export interface StoredWatchdogJob {
  id: string;
  name: string;
  agentId: string;
  workspaceId: string;
  cwd: string;
  command: string;
  args: string[];
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out";
  deliveryStatus: "pending" | "delivered";
  workerPid: number | null;
  result: WatchdogResult | null;
  timeoutMs: number | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface WatchdogLauncher {
  launch(input: {
    jobId: string;
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
  }): Promise<{ pid: number }>;
}

export interface WatchdogResultReader {
  read(jobId: string): Promise<WatchdogResult | null>;
}

export interface WatchdogNotifier {
  notify(job: StoredWatchdogJob): Promise<"delivered" | "busy">;
}

export interface RegisterWatchdogInput {
  name: string;
  agentId: string;
  workspaceId: string;
  cwd: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
}

interface WatchdogServiceOptions {
  paseoHome: string;
  launcher: WatchdogLauncher;
  resultReader: WatchdogResultReader;
  notifier: WatchdogNotifier;
  logger: Logger;
  now?: () => Date;
  idGenerator?: () => string;
  reconcileIntervalMs?: number;
  retentionMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export class WatchdogService {
  private readonly store: WatchdogStore;
  private readonly launcher: WatchdogLauncher;
  private readonly resultReader: WatchdogResultReader;
  private readonly notifier: WatchdogNotifier;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly reconcileIntervalMs: number;
  private readonly retentionMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private reconciliation: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lifecycleVersion = 0;

  constructor(options: WatchdogServiceOptions) {
    this.logger = options.logger.child({ module: "watchdog-service" });
    this.store = new WatchdogStore(path.join(options.paseoHome, "watchdogs"), this.logger);
    this.launcher = options.launcher;
    this.resultReader = options.resultReader;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 2_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1_000;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    const lifecycleVersion = ++this.lifecycleVersion;
    await this.reconcile();
    if (lifecycleVersion !== this.lifecycleVersion) {
      return;
    }
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => {
        this.logger.error({ err: error }, "Watchdog reconciliation failed");
      });
    }, this.reconcileIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.lifecycleVersion += 1;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.reconciliation;
  }

  async register(input: RegisterWatchdogInput): Promise<StoredWatchdogJob> {
    const now = this.now().toISOString();
    const queued = normalizeStoredWatchdogJob({
      id: this.idGenerator(),
      name: requireNonEmpty(input.name, "name"),
      agentId: requireNonEmpty(input.agentId, "agentId"),
      workspaceId: requireNonEmpty(input.workspaceId, "workspaceId"),
      cwd: requireNonEmpty(input.cwd, "cwd"),
      command: requireNonEmpty(input.command, "command"),
      args: input.args ?? [],
      status: "queued",
      deliveryStatus: "pending",
      workerPid: null,
      result: null,
      timeoutMs: input.timeoutMs ?? null,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
    });
    await this.store.write(queued);

    let launched: { pid: number };
    try {
      launched = await this.launcher.launch({
        jobId: queued.id,
        cwd: queued.cwd,
        command: queued.command,
        args: queued.args,
        ...(queued.timeoutMs === null ? {} : { timeoutMs: queued.timeoutMs }),
      });
    } catch (error) {
      const failed = normalizeStoredWatchdogJob({
        ...queued,
        status: "failed",
        result: {
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: this.now().toISOString(),
        },
        updatedAt: this.now().toISOString(),
      });
      await this.store.write(failed);
      this.logger.error({ err: error, watchdogId: failed.id }, "Failed to launch watchdog job");
      throw error;
    }

    const running = normalizeStoredWatchdogJob({
      ...queued,
      status: "running",
      workerPid: launched.pid,
      updatedAt: this.now().toISOString(),
    });
    try {
      await this.store.write(running);
    } catch (error) {
      this.logger.warn(
        { err: error, watchdogId: running.id, workerPid: running.workerPid },
        "Watchdog worker started but running state could not be persisted",
      );
    }
    return running;
  }

  async listForAgent(agentId: string): Promise<StoredWatchdogJob[]> {
    return (await this.store.list()).filter((job) => job.agentId === agentId);
  }

  async list(): Promise<StoredWatchdogJob[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredWatchdogJob> {
    const job = await this.store.get(id);
    if (!job) throw new Error(`Watchdog job not found: ${id}`);
    return job;
  }

  async cancel(id: string): Promise<StoredWatchdogJob> {
    const job = await this.inspect(id);
    if (isTerminalStatus(job.status)) return job;
    const requestedAt = this.now().toISOString();
    await this.store.requestCancellation(job.id, requestedAt);
    const cancelling = normalizeStoredWatchdogJob({
      ...job,
      status: "cancelling",
      cancelRequestedAt: requestedAt,
      updatedAt: requestedAt,
    });
    await this.store.write(cancelling);
    return cancelling;
  }

  async reconcile(): Promise<void> {
    if (this.reconciliation) {
      return this.reconciliation;
    }
    this.reconciliation = this.reconcileJobs().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async reconcileJobs(): Promise<void> {
    for (const stored of await this.store.list()) {
      try {
        const job = await this.reconcileActiveJob(stored);
        if (!job) {
          continue;
        }
        await this.deliverIfPending(job);
      } catch (error) {
        this.logger.warn({ err: error, jobId: stored.id }, "Watchdog job reconciliation failed");
      }
    }
    await this.store.pruneDeliveredBefore(this.now().getTime() - this.retentionMs);
  }

  private async reconcileActiveJob(stored: StoredWatchdogJob): Promise<StoredWatchdogJob | null> {
    if (
      stored.status !== "queued" &&
      stored.status !== "running" &&
      stored.status !== "cancelling"
    ) {
      return stored;
    }

    const result = await this.resultReader.read(stored.id);
    if (!result) {
      return this.reconcileActiveJobWithoutResult(stored);
    }

    const job = normalizeStoredWatchdogJob({
      ...stored,
      status: statusForResult(result),
      result,
      updatedAt: this.now().toISOString(),
    });
    await this.store.write(job);
    return job;
  }

  private async reconcileActiveJobWithoutResult(
    job: StoredWatchdogJob,
  ): Promise<StoredWatchdogJob | null> {
    if (job.status === "queued" && job.workerPid === null) {
      return this.reconcileQueuedWithoutPid(job);
    }
    if (job.workerPid !== null && !this.isProcessAlive(job.workerPid)) {
      return this.failDeadWorker(job);
    }
    return null;
  }

  private async reconcileQueuedWithoutPid(
    job: StoredWatchdogJob,
  ): Promise<StoredWatchdogJob | null> {
    // Crash window: worker acquired the durable lock before the daemon
    // persisted workerPid/running. Prefer adopting a live lock owner;
    // only fail for operator inspection when the lock PID is gone.
    const lockRead = await this.store.readWorkerLock(job.id);
    if (lockRead.status === "missing") {
      await this.launchQueuedJob(job);
      return null;
    }
    if (lockRead.status === "valid" && this.isProcessAlive(lockRead.lock.pid)) {
      await this.adoptQueuedWithLiveLock(job, lockRead.lock.pid);
      return null;
    }
    return this.failQueuedWithExistingLock(job);
  }

  private async adoptQueuedWithLiveLock(
    job: StoredWatchdogJob,
    workerPid: number,
  ): Promise<StoredWatchdogJob> {
    const running = normalizeStoredWatchdogJob({
      ...job,
      status: "running",
      workerPid,
      updatedAt: this.now().toISOString(),
    });
    await this.store.write(running);
    return running;
  }

  private async failQueuedWithExistingLock(job: StoredWatchdogJob): Promise<StoredWatchdogJob> {
    const failed = normalizeStoredWatchdogJob({
      ...job,
      status: "failed",
      result: {
        exitCode: null,
        signal: null,
        error:
          "Watchdog worker lock exists without a persisted result or workerPid; refusing to relaunch for operator inspection",
        finishedAt: this.now().toISOString(),
      },
      updatedAt: this.now().toISOString(),
    });
    await this.store.write(failed);
    return failed;
  }

  private async launchQueuedJob(job: StoredWatchdogJob): Promise<StoredWatchdogJob> {
    const launched = await this.launcher.launch({
      jobId: job.id,
      cwd: job.cwd,
      command: job.command,
      args: job.args,
      ...(job.timeoutMs === null ? {} : { timeoutMs: job.timeoutMs }),
    });
    const running = normalizeStoredWatchdogJob({
      ...job,
      status: "running",
      workerPid: launched.pid,
      updatedAt: this.now().toISOString(),
    });
    await this.store.write(running);
    return running;
  }

  private async failDeadWorker(job: StoredWatchdogJob): Promise<StoredWatchdogJob> {
    const failed = normalizeStoredWatchdogJob({
      ...job,
      status: "failed",
      result: {
        exitCode: null,
        signal: null,
        error: `Watchdog worker pid ${job.workerPid} exited without writing a result`,
        finishedAt: this.now().toISOString(),
      },
      updatedAt: this.now().toISOString(),
    });
    await this.store.write(failed);
    return failed;
  }

  private async deliverIfPending(job: StoredWatchdogJob): Promise<void> {
    if (!isTerminalStatus(job.status) || job.deliveryStatus === "delivered") {
      return;
    }
    const notification = await this.notifier.notify(job);
    if (notification === "busy") {
      return;
    }
    const deliveredAt = this.now().toISOString();
    await this.store.write(
      normalizeStoredWatchdogJob({
        ...job,
        deliveryStatus: "delivered",
        deliveredAt,
        updatedAt: deliveredAt,
      }),
    );
  }
}

class WatchdogStore {
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async write(job: StoredWatchdogJob): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeJsonFileAtomic(this.filePath(job.id), normalizeStoredWatchdogJob(job), {
      mode: 0o600,
    });
  }

  async get(id: string): Promise<StoredWatchdogJob | null> {
    try {
      return normalizeStoredWatchdogJob(
        StoredWatchdogJobRawSchema.parse(JSON.parse(await readFile(this.filePath(id), "utf8"))),
      );
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async requestCancellation(id: string, requestedAt: string): Promise<void> {
    const validId = requireValidJobId(id);
    await writeJsonFileAtomic(
      path.join(this.directory, "cancellations", `${validId}.json`),
      { jobId: validId, requestedAt },
      { mode: 0o600 },
    );
  }

  async list(): Promise<StoredWatchdogJob[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const jobs: StoredWatchdogJob[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.directory, entry.name);
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        const job = normalizeStoredWatchdogJob(StoredWatchdogJobRawSchema.parse(parsed));
        const expectedId = entry.name.slice(0, -".json".length);
        if (job.id !== expectedId) {
          throw new Error(`Watchdog record id ${job.id} does not match filename ${entry.name}`);
        }
        jobs.push(job);
      } catch (error) {
        const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
        try {
          await rename(filePath, quarantinePath);
        } catch (quarantineError) {
          this.logger.warn(
            { err: quarantineError, filePath },
            "Failed to quarantine invalid watchdog job",
          );
        }
        this.logger.warn(
          { err: error, filePath, quarantinePath },
          "Quarantined invalid watchdog job",
        );
      }
    }
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async pruneDeliveredBefore(cutoffMs: number): Promise<void> {
    for (const job of await this.list()) {
      if (
        job.deliveryStatus !== "delivered" ||
        !isTerminalStatus(job.status) ||
        Date.parse(job.updatedAt) >= cutoffMs
      ) {
        continue;
      }
      const id = requireValidJobId(job.id);
      await Promise.all([
        rm(this.filePath(id), { force: true }),
        rm(path.join(this.directory, "requests", `${id}.json`), { force: true }),
        rm(path.join(this.directory, "results", `${id}.json`), { force: true }),
        rm(path.join(this.directory, "logs", `${id}.stdout.log`), { force: true }),
        rm(path.join(this.directory, "logs", `${id}.stderr.log`), { force: true }),
        rm(this.lockPath(id), { force: true }),
        rm(path.join(this.directory, "cancellations", `${id}.json`), { force: true }),
      ]);
    }
  }

  async readWorkerLock(id: string): Promise<WatchdogWorkerLockRead> {
    const lockPath = this.lockPath(id);
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { status: "missing" };
      throw error;
    }
    try {
      return {
        status: "valid",
        lock: WatchdogWorkerLockSchema.parse(JSON.parse(raw)),
      };
    } catch (error) {
      const quarantinePath = `${lockPath}.corrupt-${Date.now()}`;
      try {
        await rename(lockPath, quarantinePath);
      } catch (quarantineError) {
        this.logger.warn(
          { err: quarantineError, lockPath },
          "Failed to quarantine invalid watchdog worker lock",
        );
      }
      this.logger.warn(
        { err: error, lockPath, quarantinePath },
        "Quarantined invalid watchdog worker lock",
      );
      return { status: "corrupt" };
    }
  }

  private lockPath(id: string): string {
    return path.join(this.directory, "locks", `${requireValidJobId(id)}.lock`);
  }

  private filePath(id: string): string {
    return path.join(this.directory, `${requireValidJobId(id)}.json`);
  }
}

export function normalizeStoredWatchdogJob(
  value: z.infer<typeof StoredWatchdogJobRawSchema> | StoredWatchdogJob,
): StoredWatchdogJob {
  const parsed = StoredWatchdogJobRawSchema.parse(value);
  return {
    id: parsed.id,
    name: parsed.name,
    agentId: parsed.agentId,
    workspaceId: parsed.workspaceId,
    cwd: parsed.cwd,
    command: parsed.command,
    args: parsed.args ?? [],
    status: parsed.status,
    deliveryStatus: parsed.deliveryStatus ?? "pending",
    workerPid: parsed.workerPid ?? null,
    result: parsed.result ?? null,
    timeoutMs: parsed.timeoutMs ?? null,
    cancelRequestedAt: parsed.cancelRequestedAt ?? null,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    deliveredAt: parsed.deliveredAt ?? null,
  };
}

function isTerminalStatus(status: StoredWatchdogJob["status"]): boolean {
  return ["completed", "failed", "cancelled", "timed_out"].includes(status);
}

function statusForResult(result: WatchdogResult): StoredWatchdogJob["status"] {
  if (result.terminationReason === "cancelled") return "cancelled";
  if (result.terminationReason === "timeout") return "timed_out";
  if (result.error || result.exitCode === null || result.exitCode !== 0) return "failed";
  return "completed";
}

function requireValidJobId(id: string): string {
  if (!WATCHDOG_JOB_ID_PATTERN.test(id)) {
    throw new Error(`Invalid watchdog job id: ${id}`);
  }
  return id;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorWithCode(error, "EPERM");
  }
}
