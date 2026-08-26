import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  WatchdogService,
  type WatchdogLauncher,
  type WatchdogNotifier,
  type WatchdogResult,
  type WatchdogResultReader,
} from "./service.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("WatchdogService", () => {
  test("registers a durable job and returns while the external command is still running", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const launcher = new FakeLauncher();
    const service = createService({ paseoHome: tempHome, launcher });

    const job = await service.register({
      name: "vision tests",
      agentId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test", "--", "vision"],
      timeoutMs: 60_000,
    });

    expect(job).toMatchObject({
      name: "vision tests",
      status: "running",
      workerPid: 4101,
      command: "npm",
      args: ["test", "--", "vision"],
    });
    expect(launcher.launched).toEqual([
      {
        jobId: job.id,
        cwd: "/workspace",
        command: "npm",
        args: ["test", "--", "vision"],
        timeoutMs: 60_000,
      },
    ]);
    expect(await service.listForAgent(job.agentId)).toEqual([job]);
  });

  test("a restarted service delivers a completed job exactly once", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const resultReader = new FakeResultReader();
    const firstService = createService({ paseoHome: tempHome, resultReader });
    const job = await firstService.register({
      name: "remote inference",
      agentId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "uv",
      args: ["run", "infer.py"],
    });
    resultReader.results.set(job.id, {
      exitCode: 0,
      signal: null,
      error: null,
      finishedAt: "2026-08-19T00:05:00.000Z",
    });
    const notifier = new FakeNotifier();
    const restartedService = createService({
      paseoHome: tempHome,
      resultReader,
      notifier,
    });

    await restartedService.reconcile();
    await restartedService.reconcile();

    expect(notifier.notified).toEqual([
      {
        id: job.id,
        agentId: job.agentId,
        status: "completed",
        result: {
          exitCode: 0,
          signal: null,
          error: null,
          finishedAt: "2026-08-19T00:05:00.000Z",
        },
      },
    ]);
    expect(await restartedService.listForAgent(job.agentId)).toEqual([
      expect.objectContaining({
        id: job.id,
        status: "completed",
        deliveryStatus: "delivered",
        deliveredAt: "2026-08-19T00:00:00.000Z",
      }),
    ]);
  });

  test("a notification failure does not block other completed jobs", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const launcher = new FakeLauncher();
    const results = new FakeResultReader();
    let blockedJobId = "";
    const delivered: string[] = [];
    const notifier: WatchdogNotifier = {
      async notify(job) {
        if (job.id === blockedJobId) {
          throw new Error("agent is archived");
        }
        delivered.push(job.id);
        return "delivered";
      },
    };
    let nextId = 0;
    const service = createService({
      paseoHome: tempHome,
      launcher,
      resultReader: results,
      notifier,
      idGenerator: () => `watchdog-${++nextId}`,
    });
    const blocked = await service.register({
      name: "blocked",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/workspace-1",
      command: "npm",
      args: ["test"],
    });
    blockedJobId = blocked.id;
    const deliverable = await service.register({
      name: "deliverable",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/workspace-1",
      command: "npm",
      args: ["run", "build"],
    });
    const result: WatchdogResult = {
      exitCode: 0,
      signal: null,
      error: null,
      finishedAt: "2026-08-19T00:05:00.000Z",
    };
    results.results.set(blocked.id, result);
    results.results.set(deliverable.id, result);

    await service.reconcile();

    expect(delivered).toEqual([deliverable.id]);
    expect(
      (await service.listForAgent("agent-1")).find((job) => job.id === blocked.id)?.status,
    ).toBe("completed");
  });

  test("quarantines a corrupt record without blocking startup", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const watchdogDirectory = path.join(tempHome, "watchdogs");
    await mkdir(watchdogDirectory, { recursive: true });
    await writeFile(path.join(watchdogDirectory, "broken.json"), "not-json", "utf8");
    const service = createService({ paseoHome: tempHome });

    await expect(service.start()).resolves.toBeUndefined();
    await service.stop();

    expect(await readdir(watchdogDirectory)).toEqual([
      expect.stringMatching(/^broken\.json\.corrupt-/),
    ]);
  });

  test("quarantines records whose id is invalid or does not match the filename", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const watchdogDirectory = path.join(tempHome, "watchdogs");
    await mkdir(watchdogDirectory, { recursive: true });
    const base = {
      name: "tampered",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
      status: "queued",
      deliveryStatus: "pending",
      workerPid: null,
      result: null,
      timeoutMs: null,
      cancelRequestedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      deliveredAt: null,
    };
    await writeFile(
      path.join(watchdogDirectory, "safe.json"),
      JSON.stringify({ ...base, id: "../../escape" }),
    );
    await writeFile(
      path.join(watchdogDirectory, "expected.json"),
      JSON.stringify({ ...base, id: "different" }),
    );
    const service = createService({ paseoHome: tempHome });

    await service.reconcile();

    expect(await service.list()).toEqual([]);
    const files = await readdir(watchdogDirectory);
    expect(files.some((entry) => entry.startsWith("safe.json.corrupt-"))).toBe(true);
    expect(files.some((entry) => entry.startsWith("expected.json.corrupt-"))).toBe(true);
  });

  test("durably cancels a running job and delivers the cancelled result", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const results = new FakeResultReader();
    const notifier = new FakeNotifier();
    const service = createService({ paseoHome: tempHome, resultReader: results, notifier });
    const job = await service.register({
      name: "cancel me",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
    });

    const cancelling = await service.cancel(job.id);

    expect(cancelling).toMatchObject({
      status: "cancelling",
      cancelRequestedAt: expect.any(String),
    });
    expect(
      JSON.parse(
        await readFile(path.join(tempHome, "watchdogs", "cancellations", `${job.id}.json`), "utf8"),
      ),
    ).toMatchObject({ jobId: job.id, requestedAt: expect.any(String) });

    results.results.set(job.id, {
      exitCode: null,
      signal: "SIGTERM",
      error: null,
      finishedAt: "2026-08-19T00:05:00.000Z",
      terminationReason: "cancelled",
    });
    await service.reconcile();

    expect(notifier.notified).toEqual([
      expect.objectContaining({ id: job.id, status: "cancelled" }),
    ]);
    expect(await service.inspect(job.id)).toMatchObject({
      status: "cancelled",
      deliveryStatus: "delivered",
    });
  });

  test("prunes delivered terminal jobs and artifacts after retention", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const results = new FakeResultReader();
    const first = createService({ paseoHome: tempHome, resultReader: results });
    const job = await first.register({
      name: "old job",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
    });
    results.results.set(job.id, {
      exitCode: 0,
      signal: null,
      error: null,
      finishedAt: "2026-08-19T00:05:00.000Z",
    });
    await first.reconcile();
    const artifact = path.join(tempHome, "watchdogs", "logs", `${job.id}.stdout.log`);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "done", "utf8");

    const retained = new WatchdogService({
      paseoHome: tempHome,
      launcher: new FakeLauncher(),
      resultReader: results,
      notifier: new FakeNotifier(),
      logger: createTestLogger(),
      now: () => new Date("2026-09-19T00:00:01.000Z"),
      idGenerator: () => "unused",
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });
    await retained.reconcile();

    expect(await retained.list()).toEqual([]);
    await expect(access(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not arm reconciliation after stop races an in-flight start", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    let releaseRead: (() => void) | undefined;
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const resultReader: WatchdogResultReader = {
      read: async () => {
        reads += 1;
        signalReadStarted?.();
        await release;
        return null;
      },
    };
    const service = createService({ paseoHome: tempHome, resultReader, reconcileIntervalMs: 5 });
    await service.register({
      name: "startup race",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
    });

    const starting = service.start();
    await readStarted;
    const stopping = service.stop();
    releaseRead?.();
    await Promise.all([starting, stopping]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reads).toBe(1);
  });

  test("marks a job failed when the worker pid is gone without a result", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const service = new WatchdogService({
      paseoHome: tempHome,
      launcher: new FakeLauncher(),
      resultReader: new FakeResultReader(),
      notifier: new FakeNotifier(),
      logger: createTestLogger(),
      now: () => new Date("2026-08-19T00:00:00.000Z"),
      idGenerator: () => "watchdog-dead",
      isProcessAlive: () => false,
    });
    const job = await service.register({
      name: "missing receipt",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
    });

    await service.reconcile();

    expect(await service.inspect(job.id)).toMatchObject({
      status: "failed",
      result: {
        error: expect.stringContaining("exited without writing a result"),
      },
    });
  });

  test("queued job with a live worker lock adopts the pid and does not relaunch", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const jobId = "watchdog-live-lock";
    const lockPid = 4242;
    const lockPath = await seedQueuedJobWithLock({
      paseoHome: tempHome,
      jobId,
      name: "live lock adoption",
      lockPid,
    });
    const launcher = new FakeLauncher();
    const notifier = new FakeNotifier();
    const service = new WatchdogService({
      paseoHome: tempHome,
      launcher,
      resultReader: new FakeResultReader(),
      notifier,
      logger: createTestLogger(),
      now: () => new Date("2026-08-19T00:00:00.000Z"),
      idGenerator: () => "unused",
      isProcessAlive: (pid) => pid === lockPid,
    });

    await service.reconcile();

    expect(launcher.launched).toEqual([]);
    expect(notifier.notified).toEqual([]);
    expect(await service.inspect(jobId)).toMatchObject({
      status: "running",
      workerPid: lockPid,
      result: null,
      deliveryStatus: "pending",
    });
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  test("queued job with a dead worker lock fails without relaunching", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const jobId = "watchdog-dead-lock";
    const lockPath = await seedQueuedJobWithLock({
      paseoHome: tempHome,
      jobId,
      name: "dead lock failure",
      lockPid: 4242,
    });
    const launcher = new FakeLauncher();
    const notifier = new FakeNotifier();
    const service = new WatchdogService({
      paseoHome: tempHome,
      launcher,
      resultReader: new FakeResultReader(),
      notifier,
      logger: createTestLogger(),
      now: () => new Date("2026-08-19T00:00:00.000Z"),
      idGenerator: () => "unused",
      isProcessAlive: () => false,
    });

    await service.reconcile();

    expect(launcher.launched).toEqual([]);
    expect(await service.inspect(jobId)).toMatchObject({
      status: "failed",
      workerPid: null,
      result: {
        error: expect.stringContaining("refusing to relaunch for operator inspection"),
      },
    });
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  test("classifies non-zero exits as failed", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-"));
    const results = new FakeResultReader();
    const notifier = new FakeNotifier();
    const service = createService({ paseoHome: tempHome, resultReader: results, notifier });
    const job = await service.register({
      name: "failing tests",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
    });
    results.results.set(job.id, {
      exitCode: 1,
      signal: null,
      error: null,
      finishedAt: "2026-08-19T00:05:00.000Z",
    });

    await service.reconcile();

    expect(notifier.notified).toEqual([expect.objectContaining({ id: job.id, status: "failed" })]);
  });
});

function createService(options: {
  paseoHome: string;
  launcher?: WatchdogLauncher;
  resultReader?: WatchdogResultReader;
  notifier?: WatchdogNotifier;
  idGenerator?: () => string;
  reconcileIntervalMs?: number;
}): WatchdogService {
  return new WatchdogService({
    paseoHome: options.paseoHome,
    launcher: options.launcher ?? new FakeLauncher(),
    resultReader: options.resultReader ?? new FakeResultReader(),
    notifier: options.notifier ?? new FakeNotifier(),
    logger: createTestLogger(),
    now: () => new Date("2026-08-19T00:00:00.000Z"),
    idGenerator: options.idGenerator ?? (() => "watchdog-1"),
    reconcileIntervalMs: options.reconcileIntervalMs,
  });
}

async function seedQueuedJobWithLock(input: {
  paseoHome: string;
  jobId: string;
  name: string;
  lockPid: number;
}): Promise<string> {
  const watchdogDirectory = path.join(input.paseoHome, "watchdogs");
  const locksDirectory = path.join(watchdogDirectory, "locks");
  await mkdir(locksDirectory, { recursive: true });
  await writeFile(
    path.join(watchdogDirectory, `${input.jobId}.json`),
    JSON.stringify({
      id: input.jobId,
      name: input.name,
      agentId: "agent-1",
      workspaceId: "workspace-1",
      cwd: "/workspace",
      command: "npm",
      args: ["test"],
      status: "queued",
      deliveryStatus: "pending",
      workerPid: null,
      result: null,
      timeoutMs: null,
      cancelRequestedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      deliveredAt: null,
    }),
    "utf8",
  );
  const lockPath = path.join(locksDirectory, `${input.jobId}.lock`);
  await writeFile(
    lockPath,
    JSON.stringify({ pid: input.lockPid, startedAt: "2026-08-19T00:00:00.000Z" }),
    "utf8",
  );
  return lockPath;
}

class FakeLauncher implements WatchdogLauncher {
  readonly launched: Array<{
    jobId: string;
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
  }> = [];

  async launch(input: {
    jobId: string;
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
  }): Promise<{ pid: number }> {
    this.launched.push(input);
    return { pid: 4101 };
  }
}

class FakeResultReader implements WatchdogResultReader {
  readonly results = new Map<string, WatchdogResult>();

  async read(jobId: string): Promise<WatchdogResult | null> {
    return this.results.get(jobId) ?? null;
  }
}

class FakeNotifier implements WatchdogNotifier {
  readonly notified: Array<{
    id: string;
    agentId: string;
    status: string;
    result: WatchdogResult | null;
  }> = [];

  async notify(job: Parameters<WatchdogNotifier["notify"]>[0]): Promise<"delivered" | "busy"> {
    this.notified.push({
      id: job.id,
      agentId: job.agentId,
      status: job.status,
      result: job.result,
    });
    return "delivered";
  }
}
