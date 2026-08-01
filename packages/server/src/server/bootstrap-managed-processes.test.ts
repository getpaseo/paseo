import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type {
  ManagedProcessRecord,
  ManagedProcessRecordInput,
  ManagedProcessRegistry,
  ManagedProcessReapOptions,
  ManagedProcessReapResult,
} from "./managed-processes/managed-processes.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

let tempRoot: string | null = null;
let staticDir: string | null = null;

afterEach(async () => {
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
});

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
