import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HubRelationshipController } from "./hub/relationship-controller.js";
import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessListOptions,
  ManagedProcessRegistry,
  ManagedProcessReapOptions,
  ManagedProcessReapResult,
} from "./managed-processes/managed-processes.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

let tempRoot: string | null = null;
let staticDir: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    tempRoot ? rm(tempRoot, { recursive: true, force: true }) : Promise.resolve(),
    staticDir ? rm(staticDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
  tempRoot = null;
  staticDir = null;
});

describe("daemon managed process bootstrap", () => {
  test("reaps stale helper process records during daemon bootstrap", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new FakeManagedProcesses([createManagedProcessRecord("leftover")]);
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
        appBaseUrl: "https://app.paseo.sh",
        managedProcesses,
      } as PaseoDaemonConfig,
      pino({ level: "silent" }),
    );

    try {
      expect(managedProcesses.reapCount).toBe(1);
    } finally {
      await daemon.stop().catch(() => undefined);
    }
  });

  test("retries retained reap failures during the same daemon run", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new FakeManagedProcesses(
      [createManagedProcessRecord("leftover")],
      [
        createReapResult([{ id: "leftover", message: "inspection failed" }]),
        createReapResult([{ id: "leftover", message: "inspection still failed" }]),
        createReapResult([]),
      ],
    );
    const scheduledRetries: Array<() => void> = [];
    const retryWaiters: Array<() => void> = [];
    const waitForRetry = async (): Promise<() => void> => {
      if (scheduledRetries.length === 0) {
        await new Promise<void>((resolve) => retryWaiters.push(resolve));
      }
      const retry = scheduledRetries.shift();
      if (!retry) {
        throw new Error("Managed process retry was not scheduled");
      }
      return retry;
    };
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
        appBaseUrl: "https://app.paseo.sh",
        managedProcesses,
      } as PaseoDaemonConfig,
      pino({ level: "silent" }),
      {
        scheduleManagedProcessReapRetry: (callback) => {
          scheduledRetries.push(callback);
          retryWaiters.shift()?.();
          return () => {
            const index = scheduledRetries.indexOf(callback);
            if (index >= 0) {
              scheduledRetries.splice(index, 1);
            }
          };
        },
      },
    );

    try {
      expect(managedProcesses.reapCount).toBe(1);
      const firstRetry = await waitForRetry();

      managedProcesses.add(createManagedProcessRecord("healthy-post-bootstrap"));
      firstRetry();
      const secondRetry = await waitForRetry();

      expect(managedProcesses.reapCount).toBe(2);

      secondRetry();
      await Promise.resolve();

      expect(managedProcesses.reapCount).toBe(3);
      expect(managedProcesses.reapedRecordIds).toEqual([["leftover"], ["leftover"], ["leftover"]]);
      expect((await managedProcesses.list()).map((record) => record.id)).toContain(
        "healthy-post-bootstrap",
      );
    } finally {
      await daemon.stop().catch(() => undefined);
    }
  });

  test("does not start reconciliation when daemon construction fails", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new FakeManagedProcesses(
      [createManagedProcessRecord("leftover")],
      [createReapResult([{ id: "leftover", message: "inspection failed" }])],
    );

    await expect(
      createPaseoDaemon(
        {
          listen: String.raw`C:\invalid-listen-target`,
          paseoHome,
          corsAllowedOrigins: [],
          hostnames: true,
          mcpEnabled: false,
          staticDir,
          mcpDebug: false,
          agentClients: createTestAgentClients(),
          agentStoragePath: path.join(paseoHome, "agents"),
          relayEnabled: false,
          appBaseUrl: "https://app.paseo.sh",
          managedProcesses,
        } as PaseoDaemonConfig,
        pino({ level: "silent" }),
      ),
    ).rejects.toThrow();

    expect(managedProcesses.reapCount).toBe(0);
  });

  test("stop cancels a delayed initial ledger read before it can reconcile", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new LifecycleManagedProcesses(
      [createManagedProcessRecord("leftover")],
      { delayFirstList: true },
    );
    const daemon = await createBootstrapTestDaemon(paseoHome, managedProcesses);
    await managedProcesses.waitForListStart();

    await daemon.stop();
    managedProcesses.releaseList();
    await Promise.resolve();

    expect(managedProcesses.reapStarts).toBe(0);
    expect(managedProcesses.recordIds).toEqual(["leftover"]);

    const replacement = await createBootstrapTestDaemon(paseoHome, managedProcesses);
    try {
      expect(managedProcesses.reapStarts).toBe(1);
      expect(managedProcesses.recordIds).toEqual([]);
    } finally {
      await replacement.stop().catch(() => undefined);
    }
  });

  test("stop joins an aborted late reap before a replacement daemon can reconcile", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new LifecycleManagedProcesses(
      [createManagedProcessRecord("leftover")],
      { delayFirstReap: true },
    );
    const daemon = await createBootstrapTestDaemon(paseoHome, managedProcesses);
    await managedProcesses.waitForReapStart();
    let stopComplete = false;

    const stop = daemon.stop().then(() => {
      stopComplete = true;
      return undefined;
    });
    await managedProcesses.waitForReapAbort();

    expect(stopComplete).toBe(false);
    expect(managedProcesses.recordIds).toEqual(["leftover"]);

    managedProcesses.releaseReap();
    await stop;

    expect(managedProcesses.recordIds).toEqual(["leftover"]);

    const replacement = await createBootstrapTestDaemon(paseoHome, managedProcesses);
    try {
      expect(managedProcesses.reapStarts).toBe(2);
      expect(managedProcesses.recordIds).toEqual([]);
    } finally {
      await replacement.stop().catch(() => undefined);
    }
  });

  test("contains managed-process retry scheduler failures", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const managedProcesses = new FakeManagedProcesses([createManagedProcessRecord("leftover")]);
    vi.spyOn(managedProcesses, "reapStale").mockRejectedValue(new Error("reaping failed"));
    const scheduleRetry = vi.fn(() => {
      throw new Error("retry scheduler unavailable");
    });
    const daemon = await createBootstrapTestDaemon(paseoHome, managedProcesses, scheduleRetry);

    await vi.waitFor(() => expect(scheduleRetry).toHaveBeenCalledOnce());
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  test("continues later teardown when managed-process retry cancellation fails", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-bootstrap-"));
    staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const paseoHome = path.join(tempRoot, ".paseo");
    const cleanupError = { id: "leftover", message: "cleanup failed" };
    const managedProcesses = new FakeManagedProcesses(
      [createManagedProcessRecord("leftover")],
      [createReapResult([cleanupError])],
    );
    const cancelRetry = vi.fn(() => {
      throw new Error("retry cancellation failed");
    });
    const scheduleRetry = vi.fn(() => cancelRetry);
    const hubStop = vi.spyOn(HubRelationshipController.prototype, "stop");
    const daemon = await createBootstrapTestDaemon(paseoHome, managedProcesses, scheduleRetry);

    await vi.waitFor(() => expect(scheduleRetry).toHaveBeenCalledOnce());
    await expect(daemon.stop()).resolves.toBeUndefined();

    expect(cancelRetry).toHaveBeenCalledOnce();
    expect(hubStop).toHaveBeenCalledOnce();
  });
});

async function createBootstrapTestDaemon(
  paseoHome: string,
  managedProcesses: ManagedProcessRegistry,
  scheduleManagedProcessReapRetry?: (callback: () => void) => () => void,
) {
  if (!staticDir) {
    throw new Error("Static directory is not initialized");
  }
  return createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      managedProcesses,
    } as PaseoDaemonConfig,
    pino({ level: "silent" }),
    scheduleManagedProcessReapRetry ? { scheduleManagedProcessReapRetry } : undefined,
  );
}

class FakeManagedProcesses implements ManagedProcessRegistry {
  reapCount = 0;
  readonly reapedRecordIds: string[][] = [];

  constructor(
    private readonly records: ManagedProcessRecord[] = [],
    private readonly reapResults: ManagedProcessReapResult[] = [],
  ) {}

  add(record: ManagedProcessRecord): void {
    this.records.push(record);
  }

  protected recordsSnapshot(): ManagedProcessRecord[] {
    return [...this.records];
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const { identityToken, ...recordInput } = input;
    return {
      id: "unused",
      ...recordInput,
      metadata: input.metadata ?? {},
      lifecycle: input.lifecycle ?? {
        execTransition: "none",
        terminationScope: "process",
      },
      identity: { commandLine: null, startedAt: null, token: identityToken ?? null },
      createdAt: "unused",
    };
  }

  async confirmExecTransition(): Promise<void> {}

  async retain(): Promise<void> {}

  async remove(): Promise<void> {}

  async list(): Promise<ManagedProcessRecord[]> {
    return [...this.records];
  }

  async reapStale(options: ManagedProcessReapOptions = {}): Promise<ManagedProcessReapResult> {
    this.reapCount += 1;
    const recordIds = this.records
      .map((record) => record.id)
      .filter((id) => !options.recordIds || options.recordIds.has(id));
    this.reapedRecordIds.push(recordIds);
    const result = this.reapResults.shift() ?? createReapResult([]);
    const retainedIds = new Set(result.errors.map((error) => error.id));
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (recordIds.includes(record.id) && !retainedIds.has(record.id)) {
        this.records.splice(index, 1);
      }
    }
    return result;
  }
}

class LifecycleManagedProcesses extends FakeManagedProcesses {
  private readonly delayFirstList: boolean;
  private readonly delayFirstReap: boolean;
  private listCalls = 0;
  private listStartedResolve: () => void = () => undefined;
  private readonly listStarted = new Promise<void>((resolve) => {
    this.listStartedResolve = resolve;
  });
  private listRelease: () => void = () => undefined;
  private readonly listGate = new Promise<void>((resolve) => {
    this.listRelease = resolve;
  });
  private reapStartedResolve: () => void = () => undefined;
  private readonly reapStarted = new Promise<void>((resolve) => {
    this.reapStartedResolve = resolve;
  });
  private reapAbortedResolve: () => void = () => undefined;
  private readonly reapAborted = new Promise<void>((resolve) => {
    this.reapAbortedResolve = resolve;
  });
  private reapRelease: () => void = () => undefined;
  private readonly reapGate = new Promise<void>((resolve) => {
    this.reapRelease = resolve;
  });
  reapStarts = 0;

  constructor(
    records: ManagedProcessRecord[],
    options: { delayFirstList?: boolean; delayFirstReap?: boolean },
  ) {
    super(records);
    this.delayFirstList = options.delayFirstList ?? false;
    this.delayFirstReap = options.delayFirstReap ?? false;
  }

  get recordIds(): string[] {
    return this.recordsSnapshot().map((record) => record.id);
  }

  override async list(options: ManagedProcessListOptions = {}): Promise<ManagedProcessRecord[]> {
    this.listCalls += 1;
    if (this.delayFirstList && this.listCalls === 1) {
      this.listStartedResolve();
      await waitForGateOrAbort(this.listGate, options.signal);
    }
    options.signal?.throwIfAborted();
    return super.list();
  }

  override async reapStale(
    options: ManagedProcessReapOptions = {},
  ): Promise<ManagedProcessReapResult> {
    this.reapStarts += 1;
    if (this.delayFirstReap && this.reapStarts === 1) {
      this.reapStartedResolve();
      const onAbort = () => this.reapAbortedResolve();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await this.reapGate;
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
    }
    options.signal?.throwIfAborted();
    return super.reapStale(options);
  }

  waitForListStart(): Promise<void> {
    return this.listStarted;
  }

  releaseList(): void {
    this.listRelease();
  }

  waitForReapStart(): Promise<void> {
    return this.reapStarted;
  }

  waitForReapAbort(): Promise<void> {
    return this.reapAborted;
  }

  releaseReap(): void {
    this.reapRelease();
  }
}

function waitForGateOrAbort(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    void gate.then(
      () => {
        signal?.removeEventListener("abort", onAbort);
        return resolve();
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        return reject(error);
      },
    );
  });
}

function createManagedProcessRecord(id: string): ManagedProcessRecord {
  return {
    id,
    owner: { provider: "opencode", kind: "helper-server" },
    pid: 4101,
    command: "opencode",
    args: ["serve"],
    metadata: {},
    lifecycle: { execTransition: "none", terminationScope: "process" },
    identity: { commandLine: "opencode serve", startedAt: "start", token: null },
    createdAt: "created",
  };
}

function createReapResult(errors: ManagedProcessReapResult["errors"]): ManagedProcessReapResult {
  return {
    checked: 1,
    dead: 0,
    mismatched: 0,
    removed: errors.length === 0 ? 1 : 0,
    terminated: errors.length === 0 ? 1 : 0,
    errors,
  };
}
