import { createHash } from "node:crypto";

import { runGitCommand } from "../../../utils/run-git-command.js";
import { projectRuntimeSource } from "../../workspace-registry.js";
import type {
  ProviderProbeClock,
  ProviderProbeService,
  ProviderProbeServiceOptions,
  ProviderProbeTimer,
} from "../index.js";
import type { ProbeStore, ProviderProbeRecord } from "./probe-store.js";

const idlePauseMilliseconds = 30 * 60_000;
const startupDestroyMilliseconds = 14 * 24 * 60 * 60_000;

interface ServiceOptions extends ProviderProbeServiceOptions {
  store: ProbeStore;
}

const systemClock: ProviderProbeClock = {
  now: () => new Date(),
  setTimeout(callback, delayMs) {
    return setTimeout(() => void callback(), delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export function createService(options: ServiceOptions): ProviderProbeService {
  const clock = options.clock ?? systemClock;
  const log = options.logger.child({ module: "provider-probe" });
  const inFlight = new Map<
    string,
    { projectId: string; promise: Promise<{ workspaceId: string }> }
  >();
  const workspaceTails = new Map<string, Promise<void>>();
  const idleTimers = new Map<string, ProviderProbeTimer>();
  let closed = false;

  return {
    records: options.store.records,
    ensure(input) {
      if (closed) return Promise.reject(new Error("Provider probe service is closed"));
      const workspaceId = probeWorkspaceId(input.projectId, input.runtimeId);
      const pending = inFlight.get(workspaceId);
      if (pending) return pending.promise;
      const ensurePromise = sequence(workspaceId, () => materialize(input, workspaceId)).finally(
        () => {
          if (inFlight.get(workspaceId)?.promise === ensurePromise) inFlight.delete(workspaceId);
        },
      );
      inFlight.set(workspaceId, { projectId: input.projectId, promise: ensurePromise });
      return ensurePromise;
    },
    async resolveProviderWorkspace(workspaceId) {
      const record = await options.store.get(workspaceId);
      if (!record || record.status !== "ready") return null;
      return options.bindWorkspaceProviderCapability(workspaceId, record.runtimeId);
    },
    async invalidateProject(projectId) {
      await Promise.allSettled(
        [...inFlight.values()]
          .filter((pending) => pending.projectId === projectId)
          .map((pending) => pending.promise),
      );
      const records = (await options.store.list()).filter(
        (record) => record.projectId === projectId,
      );
      await Promise.all(
        records.map((record) =>
          sequence(record.workspaceId, async () => {
            const current = await options.store.get(record.workspaceId);
            if (current?.projectId === projectId) await destroy(current);
          }),
        ),
      );
    },
    async reconcile() {
      const failures: unknown[] = [];
      for (const record of await options.store.list()) {
        try {
          await sequence(record.workspaceId, () => reconcileRecord(record.workspaceId));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Provider probe reconciliation failed");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearAllTimers();
      await Promise.allSettled([...inFlight.values()].map((pending) => pending.promise));
      const failures: unknown[] = [];
      for (const record of await options.store.list()) {
        try {
          await sequence(record.workspaceId, async () => {
            const current = await options.store.get(record.workspaceId);
            if (current?.status === "ready") await pause(current);
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Provider probe shutdown failed");
      }
    },
  };

  async function materialize(
    input: { projectId: string; runtimeId: string },
    workspaceId: string,
  ): Promise<{ workspaceId: string }> {
    const project = await options.projects.get(input.projectId);
    if (!project || project.archivedAt) throw new Error(`Project not found: ${input.projectId}`);
    if (!isRuntimeRegistered(input.runtimeId)) {
      throw new Error(`Workspace runtime is not registered: ${input.runtimeId}`);
    }
    const timestamp = clock.now().toISOString();
    const fingerprint = await probeFingerprint({
      projectId: project.projectId,
      source: projectRuntimeSource(project),
      runtimeId: input.runtimeId,
      runtimeConfiguration: options.runtimeConfiguration?.[input.runtimeId],
    });
    let existing = await options.store.get(workspaceId);
    if (
      existing &&
      (existing.projectId !== project.projectId ||
        existing.runtimeId !== input.runtimeId ||
        existing.fingerprint !== fingerprint ||
        existing.status === "destroying")
    ) {
      await destroy(existing);
      existing = null;
    }
    if (existing) {
      const inspection = await options.runtime.inspect(workspaceId);
      if (inspection.status === "ready") {
        await markReady(existing, timestamp);
        return { workspaceId };
      }
      if (inspection.status === "paused") {
        await options.runtime.resume(workspaceId);
        await markReady(existing, timestamp);
        return { workspaceId };
      }
      await destroy(existing);
    }

    await options.store.put({
      workspaceId,
      projectId: project.projectId,
      runtimeId: input.runtimeId,
      fingerprint,
      status: "materializing",
      lastUsedAt: timestamp,
      createdAt: timestamp,
    });
    try {
      await options.runtime.create({
        workspaceId,
        runtimeId: input.runtimeId,
        project: {
          id: project.projectId,
          source: projectRuntimeSource(project),
        },
        placement: { kind: "existing" },
        purpose: "provider-probe",
      });
      const created = await options.store.get(workspaceId);
      if (!created) throw new Error(`Provider probe record not found after create: ${workspaceId}`);
      await markReady(created, timestamp);
      return { workspaceId };
    } catch (error) {
      const created = await options.store.get(workspaceId);
      if (created) {
        try {
          await destroy(created);
        } catch (cleanupError) {
          throw new Error(`Provider probe creation failed before cleanup: ${String(error)}`, {
            cause: cleanupError,
          });
        }
      }
      throw error;
    }
  }

  async function reconcileRecord(workspaceId: string): Promise<void> {
    const record = await options.store.get(workspaceId);
    if (!record) return;
    if (!isRuntimeRegistered(record.runtimeId)) {
      clearIdleTimer(workspaceId);
      await options.store.remove(workspaceId);
      return;
    }
    if (record.status === "destroying") {
      await destroy(record);
      return;
    }
    const project = await options.projects.get(record.projectId);
    if (!project || project.archivedAt || isExpired(record)) {
      await destroy(record);
      return;
    }
    const fingerprint = await probeFingerprint({
      projectId: project.projectId,
      source: projectRuntimeSource(project),
      runtimeId: record.runtimeId,
      runtimeConfiguration: options.runtimeConfiguration?.[record.runtimeId],
    });
    if (fingerprint !== record.fingerprint) {
      await destroy(record);
      return;
    }
    const inspection = await options.runtime.inspect(workspaceId);
    if (inspection.status === "missing" || inspection.status === "error") {
      await destroy(record);
      return;
    }
    if (inspection.status === "ready") {
      await pause(record);
      return;
    }
    await options.store.update(workspaceId, (current) => ({ ...current, status: "paused" }));
  }

  async function markReady(record: ProviderProbeRecord, timestamp: string): Promise<void> {
    await options.store.update(record.workspaceId, (current) => ({
      ...current,
      status: "ready",
      lastUsedAt: timestamp,
    }));
    scheduleIdlePause(record.workspaceId, timestamp);
  }

  async function pause(record: ProviderProbeRecord): Promise<void> {
    clearIdleTimer(record.workspaceId);
    const inspection = await options.runtime.inspect(record.workspaceId);
    if (inspection.status === "missing" || inspection.status === "error") {
      await destroy(record);
      return;
    }
    if (inspection.status === "ready") await options.runtime.pause(record.workspaceId);
    await options.store.update(record.workspaceId, (current) => ({ ...current, status: "paused" }));
  }

  async function destroy(record: ProviderProbeRecord): Promise<void> {
    clearIdleTimer(record.workspaceId);
    await options.runtime.destroy(record.workspaceId);
  }

  function scheduleIdlePause(workspaceId: string, lastUsedAt: string): void {
    clearIdleTimer(workspaceId);
    if (closed) return;
    const remaining = Math.max(
      0,
      idlePauseMilliseconds - (clock.now().getTime() - Date.parse(lastUsedAt)),
    );
    const timer = clock.setTimeout(async () => {
      idleTimers.delete(workspaceId);
      try {
        await sequence(workspaceId, async () => {
          const record = await options.store.get(workspaceId);
          if (!record || record.status !== "ready") return;
          const elapsed = clock.now().getTime() - Date.parse(record.lastUsedAt);
          if (elapsed < idlePauseMilliseconds) {
            scheduleIdlePause(workspaceId, record.lastUsedAt);
            return;
          }
          await pause(record);
        });
      } catch (error) {
        log.warn({ err: error, workspaceId }, "Failed to pause idle provider probe");
      }
    }, remaining);
    timer.unref?.();
    idleTimers.set(workspaceId, timer);
  }

  function isExpired(record: ProviderProbeRecord): boolean {
    return clock.now().getTime() - Date.parse(record.lastUsedAt) >= startupDestroyMilliseconds;
  }

  function isRuntimeRegistered(runtimeId: string): boolean {
    return options.runtime.listRuntimes().some((runtime) => runtime.runtimeId === runtimeId);
  }

  function clearIdleTimer(workspaceId: string): void {
    const timer = idleTimers.get(workspaceId);
    if (!timer) return;
    clock.clearTimeout(timer);
    idleTimers.delete(workspaceId);
  }

  function clearAllTimers(): void {
    for (const timer of idleTimers.values()) clock.clearTimeout(timer);
    idleTimers.clear();
  }

  async function sequence<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = workspaceTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    workspaceTails.set(workspaceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (workspaceTails.get(workspaceId) === tail) workspaceTails.delete(workspaceId);
    }
  }
}

function probeWorkspaceId(projectId: string, runtimeId: string): string {
  return `wksprobe_${hash({ projectId, runtimeId }).slice(0, 32)}`;
}

async function probeFingerprint(input: {
  projectId: string;
  source: ReturnType<typeof projectRuntimeSource>;
  runtimeId: string;
  runtimeConfiguration: unknown;
}): Promise<string> {
  const sourceRevision =
    input.source.kind === "host-directory"
      ? await resolveSourceRevision(input.source.path)
      : input.source.revision || null;
  return hash({ ...input, sourceRevision });
}

async function resolveSourceRevision(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "HEAD"], { cwd: rootPath });
    const revision = stdout.trim();
    return revision || null;
  } catch {
    return null;
  }
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
