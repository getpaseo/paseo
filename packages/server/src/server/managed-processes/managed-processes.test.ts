import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createManagedProcessRegistry,
  createPidTarget,
  createSystemManagedProcessTable,
  type ManagedProcessCommandRunner,
  type ManagedProcessGroupInspection,
  type ManagedProcessInspection,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes.js";
import { spawnProcess } from "../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TerminateWithTreeKillResult,
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
  test("reaps an owned leftover process group and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "process-start-token",
        token: "managed-token-4101",
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
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
      metadata: { port: 4101 },
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
      identityToken: "managed-token-4101",
    });

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
    expect(terminator.terminationTargets).toEqual([-4101]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("reaps the same owned process after its exec transition is confirmed", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const processTable = new FakeProcessTable([
      {
        pid: 4106,
        commandLine: "node /opt/opencode/bin/opencode serve --port 4106",
        startedAt: "process-start-token",
        token: "managed-token-4106",
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
      command: "node",
      args: ["/opt/opencode/bin/opencode", "serve", "--port", "4106"],
      lifecycle: { execTransition: "pending", terminationScope: "process" },
      identityToken: "managed-token-4106",
    });
    processTable.setSnapshot({
      pid: 4106,
      commandLine: "opencode-helper --port 4106",
      startedAt: "process-start-token",
      token: "managed-token-4106",
    });
    await registry.confirmExecTransition(record.id);

    expect((await registry.list())[0]).toMatchObject({
      lifecycle: { execTransition: "confirmed", terminationScope: "process" },
      identity: {
        commandLine: "opencode-helper --port 4106",
        startedAt: "process-start-token",
        token: "managed-token-4106",
      },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4106,
          commandLine: "opencode-helper --port 4106",
          startedAt: "process-start-token",
          token: "managed-token-4106",
        },
      ]),
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
    expect(terminator.terminationTargets).toEqual([4106]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("reaps an exec-renamed process after restart when its token and start time match", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4109,
        commandLine: "node /opt/opencode/bin/opencode serve --port 4109",
        startedAt: "process-start-token",
        token: "managed-token-4109",
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
      pid: 4109,
      command: "node",
      args: ["/opt/opencode/bin/opencode", "serve", "--port", "4109"],
      lifecycle: { execTransition: "pending", terminationScope: "process" },
      identityToken: "managed-token-4109",
    });
    processTable.setSnapshot({
      pid: 4109,
      commandLine: "opencode-helper --port 4109",
      startedAt: "process-start-token",
      token: "managed-token-4109",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1, errors: [] });
    expect(terminator.terminationTargets).toEqual([4109]);
    expect(await registry.list()).toEqual([]);
  });

  test("keeps an exec-renamed pending process when no identity token was recorded", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4110,
        commandLine: "node /opt/opencode/bin/opencode serve --port 4110",
        startedAt: "process-start-token",
        token: null,
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
      pid: 4110,
      command: "node",
      args: ["/opt/opencode/bin/opencode", "serve", "--port", "4110"],
      lifecycle: { execTransition: "pending", terminationScope: "process" },
    });
    processTable.setSnapshot({
      pid: 4110,
      commandLine: "opencode-helper --port 4110",
      startedAt: "process-start-token",
      token: null,
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      {
        id: expect.any(String),
        message: "managed process command does not match its captured identity",
      },
    ]);
    expect(terminator.terminationTargets).toEqual([]);
    expect(await registry.list()).toHaveLength(1);
  });

  test("does not recreate a record removed during exec-transition confirmation", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    let inspectionCount = 0;
    let markInspectionStarted: () => void = () => undefined;
    let releaseInspection: () => void = () => undefined;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    const inspectionReleased = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const processTable: ManagedProcessTable = {
      async inspect(pid) {
        inspectionCount += 1;
        if (inspectionCount === 2) {
          markInspectionStarted();
          await inspectionReleased;
        }
        return {
          status: "alive",
          snapshot: {
            pid,
            commandLine:
              inspectionCount === 1
                ? "node /opt/opencode/bin/opencode serve --port 4113"
                : "opencode-helper --port 4113",
            startedAt: "process-start-token",
            token: "managed-token-4113",
          },
        };
      },
      async inspectProcessGroup() {
        return { status: "not-found" };
      },
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4113,
      command: "node",
      args: ["/opt/opencode/bin/opencode", "serve", "--port", "4113"],
      lifecycle: { execTransition: "pending", terminationScope: "process" },
      identityToken: "managed-token-4113",
    });

    const confirmation = registry.confirmExecTransition(record.id);
    await inspectionStarted;
    const removal = registry.remove(record.id);
    releaseInspection();
    await Promise.all([confirmation, removal]);

    expect(await registry.list()).toEqual([]);
  });

  test("does not write a record when initial process identity capture fails", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4116]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });

    await expect(
      registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: 4116,
        command: "opencode",
        args: ["serve", "--port", "4116"],
        lifecycle: { execTransition: "pending", terminationScope: "process-group" },
        identityToken: "managed-token-4116",
      }),
    ).rejects.toThrow("Cannot record managed process identity: inspection failed");
    expect(await registry.list()).toEqual([]);
  });

  test("deletes a dead tokenless process-group record without signaling it", async () => {
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
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
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
    expect(terminator.terminationTargets).toEqual([]);
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
    expect(terminator.terminationTargets).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("does not terminate a reused PID with the same start stamp and command", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4111,
        commandLine: "opencode serve --port 4111",
        startedAt: "same-second-start-token",
        token: "original-managed-token",
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
      pid: 4111,
      command: "opencode",
      args: ["serve", "--port", "4111"],
      identityToken: "original-managed-token",
    });
    processTable.setSnapshot({
      pid: 4111,
      commandLine: "opencode serve --port 4111",
      startedAt: "same-second-start-token",
      token: "replacement-token",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, removed: 1, terminated: 0 });
    expect(terminator.terminationTargets).toEqual([]);
    expect(await registry.list()).toEqual([]);
  });

  test("revalidates identity immediately before sending a cleanup signal", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4112,
        commandLine: "opencode serve --port 4112",
        startedAt: "same-second-start-token",
        token: "original-managed-token",
      },
    ]);
    const terminationTargets: number[] = [];
    const terminateProcess: ProcessTerminator = async (target, options) => {
      processTable.setSnapshot({
        pid: 4112,
        commandLine: "opencode serve --port 4112",
        startedAt: "same-second-start-token",
        token: "replacement-token",
      });
      if (!(await options.beforeSignal?.("SIGTERM"))) {
        return "signal-skipped";
      }
      terminationTargets.push(target.pid ?? 0);
      return "terminated";
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4112,
      command: "opencode",
      args: ["serve", "--port", "4112"],
      identityToken: "original-managed-token",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      {
        id: expect.any(String),
        message: "managed process identity changed before a cleanup signal",
      },
    ]);
    expect(terminationTargets).toEqual([]);
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
    expect(result.errors).toEqual([{ id: expect.any(String), message: "inspection failed" }]);
    expect(terminator.terminationTargets).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("keeps an unverifiable record without terminating an unrelated process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "opencode serve --port 4105",
          startedAt: "process-start-token",
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

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([
      { id: expect.any(String), message: "managed process start time is unavailable" },
    ]);
    expect(terminator.terminationTargets).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("keeps the record when process-group cleanup times out", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4107,
        commandLine: "opencode serve --port 4107",
        startedAt: "process-start-token",
        token: "managed-token-4107",
      },
    ]);
    const terminator = new FakeProcessTerminator("kill-timeout");
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4107,
      command: "opencode",
      args: ["serve", "--port", "4107"],
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
      identityToken: "managed-token-4107",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([
      { id: expect.any(String), message: "managed process group did not exit after SIGKILL" },
    ]);
    expect(terminator.terminationTargets).toEqual([-4107]);
    expect(await registry.list()).toHaveLength(1);
  });

  test("keeps a process-group record when its leader is gone but the group is alive", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4110,
          commandLine: "opencode serve --port 4110",
          startedAt: "process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4110,
      command: "opencode",
      args: ["serve", "--port", "4110"],
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [], [4110]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({ checked: 1, dead: 0, removed: 0, terminated: 0 });
    expect(result.errors).toEqual([
      {
        id: expect.any(String),
        message: "managed process group identity token was not recorded",
      },
    ]);
    expect(terminator.terminationTargets).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("reaps an owned process group after its leader exits", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4114,
        commandLine: "opencode serve --port 4114",
        startedAt: "process-start-token",
        token: "managed-token-4114",
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
      pid: 4114,
      command: "opencode",
      args: ["serve", "--port", "4114"],
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
      identityToken: "managed-token-4114",
    });
    const restartedTable = new FakeProcessTable([], [], [4114], [[4114, "managed-token-4114"]]);
    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: restartedTable,
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
    expect(terminator.terminationTargets).toEqual([-4114]);
    expect(restartedTable.groupInspections).toEqual([
      { processGroupId: 4114, identityToken: "managed-token-4114" },
      { processGroupId: 4114, identityToken: "managed-token-4114" },
    ]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("revalidates an owned process-group member before force escalation", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable(
      [
        {
          pid: 4115,
          commandLine: "opencode serve --port 4115",
          startedAt: "process-start-token",
          token: "managed-token-4115",
        },
      ],
      [],
      [4115],
      [[4115, "managed-token-4115"]],
    );
    const signals: NodeJS.Signals[] = [];
    const terminateProcess: ProcessTerminator = async (_target, options) => {
      if (!(await options.beforeSignal?.("SIGTERM"))) {
        return "signal-skipped";
      }
      signals.push("SIGTERM");
      processTable.removeSnapshot(4115);
      if (!(await options.beforeSignal?.("SIGKILL"))) {
        return "signal-skipped";
      }
      signals.push("SIGKILL");
      return "killed";
    };
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4115,
      command: "opencode",
      args: ["serve", "--port", "4115"],
      lifecycle: { execTransition: "none", terminationScope: "process-group" },
      identityToken: "managed-token-4115",
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1, errors: [] });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(processTable.groupInspections).toEqual([
      { processGroupId: 4115, identityToken: "managed-token-4115" },
      { processGroupId: 4115, identityToken: "managed-token-4115" },
    ]);
    expect(await registry.list()).toEqual([]);
  });

  test("keeps the record when process cleanup fails", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4108,
        commandLine: "opencode serve --port 4108",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator("terminated", new Error("signal failed"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4108,
      command: "opencode",
      args: ["serve", "--port", "4108"],
    });

    const result = await registry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([{ id: expect.any(String), message: "signal failed" }]);
    expect(terminator.terminationTargets).toEqual([4108]);
    expect(await registry.list()).toHaveLength(1);
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
          "opencode serve --port 4101 HOME=/tmp PASEO_MANAGED_PROCESS_TOKEN=identity-token-4101\n",
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
        token: "identity-token-4101",
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

  test("reads Windows process identity from PowerShell", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: JSON.stringify({
          ProcessId: 4101,
          CommandLine: "C:\\opencode.exe serve --port 4101",
          CreationDate: "20260620103040.000000+000",
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
        startedAt: "20260620103040.000000+000",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$process = Get-CimInstance Win32_Process -Filter 'ProcessId = 4101'; if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
        ],
      },
    ]);
  });

  test("verifies a POSIX process group from a surviving member's identity token", async () => {
    const commandRunner = new FakeCommandRunner([
      { stdout: " 4102 4101\n 5101 5101\n", stderr: "" },
      {
        stdout: "Sat Jun 20 10:30:40 2026 opencode-child\n",
        stderr: "",
      },
      {
        stdout: "opencode-child HOME=/tmp PASEO_MANAGED_PROCESS_TOKEN=identity-token-4101\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspectProcessGroup(4101, "identity-token-4101");

    expect(inspection).toEqual({ status: "owned" });
    expect(commandRunner.commands).toEqual([
      { command: "ps", args: ["-ax", "-o", "pid=", "-o", "pgid="] },
      {
        command: "ps",
        args: ["-ww", "-p", "4102", "-o", "lstart=", "-o", "command="],
      },
      { command: "ps", args: ["eww", "-p", "4102", "-o", "command="] },
    ]);
  });

  test("continues group verification when an earlier member exits during inspection", async () => {
    const exitedDuringInspection = Object.assign(new Error("process exited"), { code: 1 });
    const commandRunner = new FakeCommandRunner([
      { stdout: " 4101 4101\n 4102 4101\n", stderr: "" },
      { stdout: "Sat Jun 20 10:30:40 2026 opencode-child\n", stderr: "" },
      exitedDuringInspection,
      { stdout: "Sat Jun 20 10:30:41 2026 opencode-child\n", stderr: "" },
      {
        stdout: "opencode-child PASEO_MANAGED_PROCESS_TOKEN=identity-token-4101\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspectProcessGroup(4101, "identity-token-4101");

    expect(inspection).toEqual({ status: "owned" });
  });
});

class FakeProcessTable implements ManagedProcessTable {
  readonly groupInspections: Array<{ processGroupId: number; identityToken: string | null }> = [];
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;
  private readonly liveProcessGroups: Set<number>;
  private readonly processGroupTokens: Map<number, string>;

  constructor(
    snapshots: ManagedProcessSnapshot[],
    errorPids: number[] = [],
    liveProcessGroups: number[] = [],
    processGroupTokens: Array<[number, string]> = [],
  ) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
    this.liveProcessGroups = new Set(liveProcessGroups);
    this.processGroupTokens = new Map(processGroupTokens);
  }

  setSnapshot(snapshot: ManagedProcessSnapshot): void {
    this.snapshots.set(snapshot.pid, snapshot);
  }

  removeSnapshot(pid: number): void {
    this.snapshots.delete(pid);
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
    identityToken: string | null,
  ): Promise<ManagedProcessGroupInspection> {
    this.groupInspections.push({ processGroupId, identityToken });
    const snapshotToken = this.snapshots.get(processGroupId)?.token;
    const groupToken = this.processGroupTokens.get(processGroupId) ?? snapshotToken;
    if (!this.liveProcessGroups.has(processGroupId) && !this.snapshots.has(processGroupId)) {
      return { status: "not-found" };
    }
    if (!identityToken) {
      return {
        status: "unverifiable",
        message: "managed process group identity token was not recorded",
      };
    }
    return groupToken === identityToken
      ? { status: "owned" }
      : {
          status: "unverifiable",
          message: "managed process group identity token is unavailable from its members",
        };
  }
}

class FakeProcessTerminator {
  readonly terminationTargets: number[] = [];

  constructor(
    private readonly result: TerminateWithTreeKillResult = "terminated",
    private readonly error?: Error,
  ) {}

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget, options) => {
    if (options.beforeSignal && !(await options.beforeSignal("SIGTERM"))) {
      return "signal-skipped";
    }
    this.terminationTargets.push(target.pid ?? 0);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  };
}

class FakeCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  private readonly responses: Array<{ stdout: string; stderr: string } | Error>;

  constructor(responses: Array<{ stdout: string; stderr: string } | Error>) {
    this.responses = [...responses];
  }

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake process-table command response available");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}
