import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createManagedProcessRegistry,
  createPidTarget,
  createSystemManagedProcessTable,
  isManagedProcessSignalAllowed,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  type ManagedProcessRecordInput,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes.js";
import { spawnProcess } from "../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("managed process registry", () => {
  test("rejects a record when it cannot capture exact process identity", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4100]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });

    await expect(
      registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4100,
        command: "opencode",
        args: ["serve", "--port", "4100"],
      }),
    ).rejects.toThrow("Cannot record managed process identity: inspection failed");
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        pid: 4100,
        identity: { commandLine: null, startedAt: null },
      }),
    ]);
  });

  test("persists ownership before process identity inspection completes", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    let releaseInspection: () => void = () => undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const processTable: ManagedProcessTable = {
      inspect: async (pid) => {
        await inspectionGate;
        return {
          status: "alive",
          snapshot: {
            pid,
            commandLine: "opencode serve --port 4114",
            startedAt: "process-start-token",
          },
        };
      },
      inspectProcessGroup: async () => "not-found",
      findOwnedProcessIds: async () => [],
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    let resolvePersistence: () => void = () => undefined;
    const persisted = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    const recording = registry.record(
      {
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4114,
        command: "opencode",
        args: ["serve", "--port", "4114"],
      },
      { onRecordPersisted: resolvePersistence },
    );

    await persisted;
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        pid: 4114,
        identity: { commandLine: null, startedAt: null },
      }),
    ]);

    releaseInspection();
    await recording;
  });

  test("does not restore a record removed during identity capture", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4117,
          commandLine: "opencode serve --port 4117",
          startedAt: "process-start-token",
        },
      ]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    let removal = Promise.resolve();

    const recording = registry.record(
      {
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4117,
        command: "opencode",
        args: ["serve", "--port", "4117"],
      },
      {
        onIdentityCaptured: (record) => {
          removal = registry.remove(record.id);
        },
      },
    );

    await expect(recording).rejects.toThrow(
      "Managed process record was removed during identity capture",
    );
    await removal;
    expect(await registry.list()).toEqual([]);
  });

  test("does not promote a direct Windows record for an unexpected process identity", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4116,
          commandLine: '"C:\\tools\\replacement.exe" serve --port 4116',
          startedAt: new Date().toISOString(),
        },
      ]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });

    await expect(
      registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4116,
        command: "C:\\tools\\opencode.exe",
        args: ["serve", "--port", "4116"],
        metadata: { directExecutable: true },
      }),
    ).rejects.toThrow("Cannot record managed process without its expected identity");
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        pid: 4116,
        identity: { commandLine: null, startedAt: null },
      }),
    ]);
  });

  test("promotes a direct Windows record with quoted and empty prefix arguments", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4122,
          commandLine: '"C:\\tools\\opencode.exe" --label "" "say \\"hello\\"" "C:\\trailing\\\\"',
          startedAt: new Date().toISOString(),
        },
      ]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });

    await expect(
      registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4122,
        command: "C:\\tools\\opencode.exe",
        args: ["--label", "", 'say "hello"', "C:\\trailing\\"],
        metadata: { directExecutable: true },
      }),
    ).resolves.toMatchObject({ pid: 4122 });
  });

  test("matches equivalent DMTF and ISO Windows start times", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4123,
        commandLine: '"C:\\tools\\opencode.exe" serve --port 4123',
        startedAt: new Date().toISOString(),
      },
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4123,
      command: "C:\\tools\\opencode.exe",
      args: ["serve", "--port", "4123"],
      metadata: { directExecutable: true },
    });
    record.identity.startedAt = "20260620103040.123456+000";
    processTable.setSnapshot({
      pid: 4123,
      commandLine: '"C:\\tools\\opencode.exe" serve --port 4123',
      startedAt: "2026-06-20T10:30:40.1234560Z",
    });

    await expect(registry.verify(record)).resolves.toBe("match");
  });

  test("fails closed when a managed process record is unreadable", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4100,
          commandLine: "opencode serve --port 4100",
          startedAt: "process-start-token",
        },
      ]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4100,
      command: "opencode",
      args: ["serve", "--port", "4100"],
    });
    await writeFile(path.join(tempHome, "runtime", "managed-processes", "unreadable.json"), "{");

    await expect(registry.list()).rejects.toThrow(
      "Unreadable managed process record: unreadable.json",
    );
  });

  test("reaps a validated leftover helper process and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      withManagedProcessOwnership({
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "process-start-token",
      }),
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record(
      withManagedProcessOwnership({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4101,
        command: "opencode",
        args: ["serve", "--port", "4101"],
        metadata: { port: 4101 },
      }),
    );

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(terminator.processOnlySignals).toEqual([true]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test.runIf(process.platform !== "win32")(
    "signals a recorded POSIX helper process group without tree discovery",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
      const processTable = new FakeProcessTable([
        withManagedProcessOwnership({
          pid: 4111,
          commandLine: "opencode serve --port 4111",
          startedAt: "process-start-token",
        }),
      ]);
      const terminator = new FakeProcessTerminator();
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: terminator.terminate,
        logger: createTestLogger(),
      });
      await registry.record(
        withManagedProcessOwnership({
          owner: { provider: "opencode", kind: "helper-server" },
          pid: 4111,
          command: "opencode",
          args: ["serve", "--port", "4111"],
          metadata: { port: 4111, terminationScope: "process-group" },
        }),
      );

      const result = await registry.reapStale();

      expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1 });
      expect(terminator.terminatedPids).toEqual([-4111]);
      expect(terminator.processOnlySignals).toEqual([false]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "cleans an owned descendant after the recorded process-group leader exits",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
      const processTable = new FakeProcessTable([
        withManagedProcessOwnership({
          pid: 4116,
          commandLine: "opencode serve --port 4116",
          startedAt: "process-start-token",
        }),
      ]);
      const terminator = new FakeProcessTerminator((pid) => processTable.removeSnapshot(pid));
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: terminator.terminate,
        logger: createTestLogger(),
      });
      await registry.record(
        withManagedProcessOwnership({
          owner: { provider: "opencode", kind: "helper-server" },
          pid: 4116,
          command: "opencode",
          args: ["serve", "--port", "4116"],
          metadata: { port: 4116, terminationScope: "process-group" },
        }),
      );
      processTable.removeSnapshot(4116);
      processTable.setOwnedProcess(
        "test-ownership-token",
        withManagedProcessOwnership({
          pid: 4117,
          commandLine: "opencode child",
          startedAt: "child-start-token",
        }),
      );

      const result = await registry.reapStale();

      expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1 });
      expect(terminator.terminatedPids).toEqual([4117]);
      expect(await registry.list()).toEqual([]);
    },
  );

  test("deletes a dead helper process record without terminating a PID", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4102,
        commandLine: "opencode serve --port 4102",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4102,
      command: "opencode",
      args: ["serve", "--port", "4102"],
      metadata: { port: 4102 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 1,
      mismatched: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("removes a reused PID record without terminating the new process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "original-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4103,
      command: "opencode",
      args: ["serve", "--port", "4103"],
      metadata: { port: 4103 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "new-process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("keeps a live legacy record whose captured identity is incomplete", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4110,
        commandLine: "opencode serve --port 4110",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4110,
      command: "opencode",
      args: ["serve", "--port", "4110"],
    });
    record.identity.commandLine = null;
    await writeFile(
      path.join(tempHome, "runtime", "managed-processes", `${record.id}.json`),
      JSON.stringify(record),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 0, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      { id: record.id, message: "managed process identity is incomplete" },
    ]);
    expect(terminator.terminatedPids).toEqual([]);
    expect(await registry.list()).toHaveLength(1);
  });

  test("reaps a direct Windows helper from its crash-safe provisional record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const snapshot: ManagedProcessSnapshot = {
      pid: 4118,
      commandLine: '"C:\\tools\\opencode.exe" serve --port 4118',
      startedAt: new Date().toISOString(),
    };
    const processTable = new FakeProcessTable([snapshot]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4118,
      command: "C:\\tools\\opencode.exe",
      args: ["serve", "--port", "4118"],
      metadata: { directExecutable: true },
    });
    record.identity = { commandLine: null, startedAt: null };
    record.createdAt = "2026-06-20T10:30:41.000Z";
    processTable.setSnapshot({
      ...snapshot,
      startedAt: "2026-06-20T10:30:40.000Z",
    });
    await writeFile(
      path.join(tempHome, "runtime", "managed-processes", `${record.id}.json`),
      JSON.stringify(record),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1 });
    expect(terminator.terminatedPids).toEqual([4118]);
  });

  test("rejects a reused Windows PID when its process started after the provisional record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4119,
        commandLine: '"C:\\tools\\opencode.exe" serve --port 4119',
        startedAt: new Date().toISOString(),
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4119,
      command: "C:\\tools\\opencode.exe",
      args: ["serve", "--port", "4119"],
      metadata: { directExecutable: true },
    });
    record.identity = { commandLine: null, startedAt: null };
    record.createdAt = "2026-06-20T10:30:41.000Z";
    processTable.setSnapshot({
      pid: 4119,
      commandLine: '"C:\\tools\\opencode.exe" serve --port 4119',
      startedAt: "2026-06-20T11:00:00.000Z",
    });
    await writeFile(
      path.join(tempHome, "runtime", "managed-processes", `${record.id}.json`),
      JSON.stringify(record),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, removed: 1, terminated: 0 });
    expect(terminator.terminatedPids).toEqual([]);
  });

  test.runIf(process.platform !== "win32")(
    "reaps a live legacy POSIX record through exact process identity",
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
      const processTable = new FakeProcessTable([
        {
          pid: 4115,
          commandLine: "opencode serve --port 4115",
          startedAt: "process-start-token",
          ownershipToken: null,
        },
      ]);
      const terminator = new FakeProcessTerminator();
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable,
        terminateProcess: terminator.terminate,
        logger: createTestLogger(),
      });
      await registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4115,
        command: "opencode",
        args: ["serve", "--port", "4115"],
      });

      const result = await registry.reapStale();

      expect(result).toMatchObject({ checked: 1, mismatched: 0, removed: 1, terminated: 1 });
      expect(result.errors).toEqual([]);
      expect(terminator.terminatedPids).toEqual([4115]);
      expect(terminator.processOnlySignals).toEqual([true]);
      expect(await registry.list()).toEqual([]);
    },
  );

  test("does not terminate a process whose full command changed at the same PID and start time", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const processTable = new FakeProcessTable([
      {
        pid: 4106,
        commandLine: "opencode serve --port 4106",
        startedAt: "same-process-start-token",
      },
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4106,
      command: "opencode",
      args: ["serve", "--port", "4106"],
    });
    processTable.setSnapshot({
      pid: 4106,
      commandLine: "node replacement-server.js --port 4106",
      startedAt: "same-process-start-token",
    });

    expect(await registry.verify(record)).toBe("mismatch");
    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, removed: 1, terminated: 0 });
    expect(terminator.terminatedPids).toEqual([]);
  });

  test("requires the POSIX ownership token when the PID, command, and start time match", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4113,
        commandLine: "opencode serve --port 4113",
        startedAt: "same-process-start-token",
        ownershipToken: "owned-token",
      },
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4113,
      command: "opencode",
      args: ["serve", "--port", "4113"],
      ownershipToken: "owned-token",
    });
    processTable.setSnapshot({
      pid: 4113,
      commandLine: "opencode serve --port 4113",
      startedAt: "same-process-start-token",
      ownershipToken: "replacement-token",
    });

    expect(await registry.verify(record)).toBe("mismatch");
  });

  test("does not match a command line whose captured whitespace changed", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4108,
        commandLine: "opencode serve --port 4108",
        startedAt: "same-process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4108,
      command: "opencode",
      args: ["serve", "--port", "4108"],
    });
    processTable.setSnapshot({
      pid: 4108,
      commandLine: "opencode  serve --port 4108",
      startedAt: "same-process-start-token",
    });

    expect(await registry.verify(record)).toBe("mismatch");
  });

  test("removes the record when process identity changes immediately before cleanup", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      withManagedProcessOwnership({
        pid: 4107,
        commandLine: "opencode serve --port 4107",
        startedAt: "original-process-start-token",
      }),
    ]);
    const signaledPids: number[] = [];
    const terminateProcess: ProcessTerminator = async (target, options) => {
      processTable.setSnapshot({
        pid: 4107,
        commandLine: "replacement-server --port 4107",
        startedAt: "replacement-process-start-token",
      });
      if (!(await options.beforeSignal?.("SIGTERM"))) {
        return "signal-skipped";
      }
      signaledPids.push(target.pid ?? -1);
      return "terminated";
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess,
      logger: createTestLogger(),
    });
    await registry.record(
      withManagedProcessOwnership({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4107,
        command: "opencode",
        args: ["serve", "--port", "4107"],
      }),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, removed: 1, terminated: 0 });
    expect(result.errors).toEqual([]);
    expect(signaledPids).toEqual([]);
    expect(await registry.list()).toEqual([]);
  });

  test("keeps the record when owned-process discovery fails after signal verification", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const snapshot: ManagedProcessSnapshot = {
      pid: 4120,
      commandLine: "opencode serve --port 4120",
      startedAt: "process-start-token",
      ownershipToken: "owned-token",
    };
    let groupInspectionCount = 0;
    const processTable: ManagedProcessTable = {
      inspect: async () => ({ status: "alive", snapshot }),
      inspectProcessGroup: async () => {
        groupInspectionCount += 1;
        return groupInspectionCount === 1 ? "match" : "not-found";
      },
      findOwnedProcessIds: async () => null,
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async (_target, options) => {
        expect(await options.beforeSignal?.("SIGTERM")).toBe(false);
        return "signal-skipped";
      },
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4120,
      command: "opencode",
      args: ["serve", "--port", "4120"],
      metadata: { terminationScope: "process-group" },
      ownershipToken: "owned-token",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      { id: record.id, message: "managed child process cleanup is incomplete" },
    ]);
    expect(await registry.list()).toHaveLength(1);
  });

  test("removes the record when the process exits before force-signal verification", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const snapshot: ManagedProcessSnapshot = withManagedProcessOwnership({
      pid: 4112,
      commandLine: "opencode serve --port 4112",
      startedAt: "process-start-token",
    });
    let inspectionCount = 0;
    const processTable: ManagedProcessTable = {
      inspect: async () => {
        inspectionCount += 1;
        return inspectionCount < 3 ? { status: "alive", snapshot } : { status: "not-found" };
      },
      inspectProcessGroup: async () => "not-found",
      findOwnedProcessIds: async () => [],
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async (_target, options) =>
        (await options.beforeSignal?.("SIGTERM")) ? "terminated" : "signal-skipped",
      logger: createTestLogger(),
    });
    await registry.record(
      withManagedProcessOwnership({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4112,
        command: "opencode",
        args: ["serve", "--port", "4112"],
      }),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, dead: 1, removed: 1, terminated: 0 });
    expect(result.errors).toEqual([]);
    expect(await registry.list()).toEqual([]);
  });

  test("keeps the record when termination cannot confirm process exit", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      withManagedProcessOwnership({
        pid: 4109,
        commandLine: "opencode serve --port 4109",
        startedAt: "process-start-token",
      }),
    ]);
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: async () => "kill-timeout",
      logger: createTestLogger(),
    });
    await registry.record(
      withManagedProcessOwnership({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4109,
        command: "opencode",
        args: ["serve", "--port", "4109"],
      }),
    );

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      {
        id: expect.any(String),
        message: "managed process did not report exit after SIGKILL",
      },
    ]);
    expect(await registry.list()).toHaveLength(1);
  });

  test("keeps a helper record when inspection fails instead of orphaning a live process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4104, commandLine: "opencode serve --port 4104", startedAt: "process-start-token" },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4104,
      command: "opencode",
      args: ["serve", "--port", "4104"],
      metadata: { port: 4104 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4104]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([
      { id: expect.any(String), message: "managed process identity is incomplete" },
    ]);
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("does not terminate a reused PID whose command line only mentions the tokens", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "opencode serve --port 4105",
          startedAt: "original-process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4105,
      command: "opencode",
      args: ["serve", "--port", "4105"],
      metadata: { port: 4105 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "node /tmp/serve.js --port 4105 # opencode helper",
          startedAt: null,
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });
});

describe("managed process signal verification", () => {
  test("requires current exact ownership before every signal", () => {
    expect(
      isManagedProcessSignalAllowed({
        signal: "SIGTERM",
        verification: "match",
        processGroupAlive: true,
      }),
    ).toBe(true);
    expect(
      isManagedProcessSignalAllowed({
        signal: "SIGTERM",
        verification: "not-found",
        processGroupAlive: true,
      }),
    ).toBe(false);
    expect(
      isManagedProcessSignalAllowed({
        signal: "SIGKILL",
        verification: "not-found",
        processGroupAlive: true,
      }),
    ).toBe(false);
  });
});

describe("managed process termination", () => {
  test("stops as soon as a terminated process exits instead of escalating to SIGKILL", async () => {
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn test process");
    }

    let forced = false;
    const result = await terminateWithTreeKill(createPidTarget(pid), {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
      onForceSignal: () => {
        forced = true;
      },
    });

    expect(result).toBe("terminated");
    expect(forced).toBe(false);
  });
});

describe("system managed process table", () => {
  test("reads POSIX process identity from ps", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: "Sat Jun 20 10:30:40 2026 opencode serve --port 4101\n",
        stderr: "",
      },
      {
        stdout:
          "opencode serve --port 4101 HOME=/tmp PASEO_HELPER_OWNERSHIP_TOKEN=ownership-token PATH=/bin\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "Sat Jun 20 10:30:40 2026",
        ownershipToken: "ownership-token",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "ps",
        args: ["-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
      },
      {
        command: "ps",
        args: ["eww", "-p", "4101", "-o", "command="],
      },
    ]);
  });

  test("finds every POSIX process that inherited an ownership token", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: [
          " 4101 opencode serve PASEO_HELPER_OWNERSHIP_TOKEN=other-token",
          " 4102 opencode child PASEO_HELPER_OWNERSHIP_TOKEN=ownership-token PATH=/bin",
          " 4103 helper PASEO_HELPER_OWNERSHIP_TOKEN=ownership-token",
        ].join("\n"),
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    await expect(processTable.findOwnedProcessIds("ownership-token")).resolves.toEqual([
      4102, 4103,
    ]);
    expect(commandRunner.commands).toEqual([
      {
        command: "ps",
        args: ["eww", "-ax", "-o", "pid=", "-o", "command="],
      },
    ]);
  });

  test("reads Windows process identity from PowerShell", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: JSON.stringify({
          ProcessId: 4101,
          CommandLine: "C:\\opencode.exe serve --port 4101",
          CreationDate: "2026-06-20T10:30:40.0000000Z",
        }),
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "C:\\opencode.exe serve --port 4101",
        startedAt: "2026-06-20T10:30:40.0000000Z",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = 4101'; if ($process) { [pscustomobject]@{ ProcessId = $process.ProcessId; CommandLine = $process.CommandLine; CreationDate = $process.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }",
        ],
      },
    ]);
  });
});

class FakeProcessTable implements ManagedProcessTable {
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;
  private readonly ownedProcessIds = new Map<string, Set<number>>();

  constructor(snapshots: ManagedProcessSnapshot[], errorPids: number[] = []) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
  }

  setSnapshot(snapshot: ManagedProcessSnapshot): void {
    this.snapshots.set(snapshot.pid, snapshot);
  }

  setOwnedProcess(ownershipToken: string, snapshot: ManagedProcessSnapshot): void {
    this.snapshots.set(snapshot.pid, snapshot);
    const processIds = this.ownedProcessIds.get(ownershipToken) ?? new Set<number>();
    processIds.add(snapshot.pid);
    this.ownedProcessIds.set(ownershipToken, processIds);
  }

  removeSnapshot(pid: number): void {
    this.snapshots.delete(pid);
    for (const processIds of this.ownedProcessIds.values()) {
      processIds.delete(pid);
    }
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (this.errorPids.has(pid)) {
      return { status: "error", error: new Error("inspection failed") };
    }
    const snapshot = this.snapshots.get(pid);
    return snapshot ? { status: "alive", snapshot } : { status: "not-found" };
  }

  async inspectProcessGroup(
    processGroupId: number,
    ownershipToken: string | null,
  ): Promise<"match" | "mismatch" | "not-found" | "unknown"> {
    const snapshot = this.snapshots.get(processGroupId);
    if (!snapshot) {
      return "not-found";
    }
    if (!snapshot.ownershipToken || !ownershipToken) {
      return "unknown";
    }
    return snapshot.ownershipToken === ownershipToken ? "match" : "mismatch";
  }

  async findOwnedProcessIds(ownershipToken: string): Promise<number[]> {
    return Array.from(this.ownedProcessIds.get(ownershipToken) ?? []);
  }
}

class FakeProcessTerminator {
  readonly processOnlySignals: boolean[] = [];
  readonly terminatedPids: number[] = [];

  constructor(private readonly onTerminate?: (pid: number) => void) {}

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget, options) => {
    if (options.beforeSignal && !(await options.beforeSignal("SIGTERM"))) {
      return "signal-skipped";
    }
    this.terminatedPids.push(target.pid ?? -1);
    this.processOnlySignals.push(options.signalProcessOnly ?? false);
    if (typeof target.pid === "number") {
      this.onTerminate?.(target.pid);
    }
    return "terminated";
  };
}

class FakeCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  private readonly responses: Array<{ stdout: string; stderr: string }>;

  constructor(responses: Array<{ stdout: string; stderr: string }>) {
    this.responses = [...responses];
  }

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake process-table command response available");
    }
    return response;
  }
}

function withManagedProcessOwnership<T extends ManagedProcessSnapshot | ManagedProcessRecordInput>(
  value: T,
): T {
  if (process.platform === "win32") {
    return (
      "owner" in value
        ? { ...value, metadata: { ...value.metadata, directExecutable: true } }
        : value
    ) as T;
  }
  return { ...value, ownershipToken: "test-ownership-token" };
}
