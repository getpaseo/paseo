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
  type ManagedProcessInspection,
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
  test("reaps a validated leftover helper process and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
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
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
      metadata: { port: 4101 },
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
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("reaps an ACP agent whose process rewrote its command line after spawn", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    // kimi (and similar CLIs) overwrite their process title, so the live
    // command line ("kimi-cod") no longer contains the "kimi acp" signature.
    // Matching start time plus the command line captured at record time must
    // still identify the leftover; otherwise the orphan leaks.
    const processTable = new FakeProcessTable([
      {
        pid: 4103,
        commandLine: "kimi-cod",
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
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4103,
      command: "kimi",
      args: ["acp"],
      metadata: { agentId: "agent-1" },
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
    expect(terminator.terminatedPids).toEqual([4103]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("does not reap a reused PID that only shares the rewritten command line", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    // Same rewritten title but a different start time: PID was reused by
    // another kimi process, so the record must go without a kill.
    const recordTable = new FakeProcessTable([
      {
        pid: 4104,
        commandLine: "kimi-cod",
        startedAt: "original-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: recordTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4104,
      command: "kimi",
      args: ["acp"],
      metadata: { agentId: "agent-1" },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4104,
          commandLine: "kimi-cod",
          startedAt: "reused-start-token",
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
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("does not terminate a reused PID whose command line only mentions the tokens", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4105]),
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
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "env",
        args: ["LC_ALL=C", "LANG=C", "ps", "-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
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
});

class FakeProcessTable implements ManagedProcessTable {
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;

  constructor(snapshots: ManagedProcessSnapshot[], errorPids: number[] = []) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (this.errorPids.has(pid)) {
      return { status: "error", error: new Error("inspection failed") };
    }
    const snapshot = this.snapshots.get(pid);
    return snapshot ? { status: "alive", snapshot } : { status: "not-found" };
  }
}

class FakeProcessTerminator {
  readonly terminatedPids: number[] = [];

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget) => {
    this.terminatedPids.push(target.pid ?? -1);
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

describe("managed process identity from /proc", () => {
  test("reads Linux process identity from /proc without ps or locale dependence", async () => {
    const commandRunner = new FakeCommandRunner([]);
    const processTable = createSystemManagedProcessTable({
      platform: "linux",
      commandRunner,
      procReader: {
        readStat: async () =>
          "4101 (kimi acp) S 1 4101 4101 0 -1 4194304 100 0 0 0 5 2 0 0 20 0 1 0 987654321 1000000 50 0 0 0 0 0 0 0 0 0 0 0 0 0",
        readCmdline: async () => "kimi\0acp\0",
        readBootId: async () => "boot-abc\n",
      },
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "kimi acp",
        startedAt: null,
        startTimeTicks: "987654321",
        bootId: "boot-abc",
      },
    });
    expect(commandRunner.commands).toEqual([]);
  });

  test("falls back to a locale-pinned ps when /proc is unavailable", async () => {
    const commandRunner = new FakeCommandRunner([
      { stdout: "Sat Jun 20 10:30:40 2026 opencode serve --port 4101\n", stderr: "" },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "linux",
      commandRunner,
      procReader: {
        readStat: async () => {
          throw new Error("EPERM");
        },
        readCmdline: async () => "",
        readBootId: async () => "boot-abc",
      },
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "Sat Jun 20 10:30:40 2026",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "env",
        args: ["LC_ALL=C", "LANG=C", "ps", "-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
      },
    ]);
  });

  test("reports not-found from /proc when the process is gone", async () => {
    const processTable = createSystemManagedProcessTable({
      platform: "linux",
      commandRunner: new FakeCommandRunner([]),
      procReader: {
        readStat: async () => {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        readCmdline: async () => "",
        readBootId: async () => "boot-abc",
      },
    });

    await expect(processTable.inspect(4101)).resolves.toEqual({ status: "not-found" });
  });
});

describe("managed process reaper with /proc identity", () => {
  function procSnapshot(
    pid: number,
    startTimeTicks: string,
    commandLine: string,
  ): ManagedProcessSnapshot {
    return { pid, commandLine, startedAt: null, startTimeTicks, bootId: "boot-abc" };
  }

  test("reaps a process whose rewritten title matches via start ticks", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([procSnapshot(4106, "111", "kimi-cod")]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4106,
      command: "kimi",
      args: ["acp"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([procSnapshot(4106, "111", "kimi-cod")]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 0, terminated: 1, removed: 1 });
    expect(terminator.terminatedPids).toEqual([4106]);
  });

  test("does not kill a reused PID with different start ticks", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([procSnapshot(4107, "111", "kimi-cod")]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4107,
      command: "kimi",
      args: ["acp"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([procSnapshot(4107, "222", "kimi-cod")]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, terminated: 0, removed: 1 });
    expect(terminator.terminatedPids).toEqual([]);
  });

  test("does not kill a matching process from a different boot", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    // The record was written under boot-abc; the machine has since rebooted
    // into boot-xyz, so the ticks must not be compared at all.
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4108,
          commandLine: "kimi-cod",
          startedAt: null,
          startTimeTicks: "111",
          bootId: "boot-abc",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4108,
      command: "kimi",
      args: ["acp"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4108,
          commandLine: "kimi-cod",
          startedAt: null,
          startTimeTicks: "111",
          bootId: "boot-xyz",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-xyz",
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, terminated: 0, removed: 1 });
    expect(terminator.terminatedPids).toEqual([]);
  });

  test("does not kill when identity evidence is incomplete", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    // Record captured no identity at all (process already dying at record
    // time); the live process only shares the PID.
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4109,
      command: "kimi",
      args: ["acp"],
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4109, commandLine: "unrelated-process", startedAt: null },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({ checked: 1, mismatched: 1, terminated: 0, removed: 1 });
    expect(terminator.terminatedPids).toEqual([]);
  });
});

describe("managed process metadata updates", () => {
  test("updateMetadata merges patches into an existing record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4110, commandLine: "kimi acp", startedAt: "start-token" },
      ]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });
    const record = await registry.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4110,
      command: "kimi",
      args: ["acp"],
      metadata: { agentId: "agent-1", sessionId: null },
    });

    await registry.updateMetadata(record.id, { sessionId: "session-1" });

    const [stored] = await registry.list();
    expect(stored.metadata).toEqual({ agentId: "agent-1", sessionId: "session-1" });
  });

  test("updateMetadata on a missing record is a no-op", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: new FakeProcessTerminator().terminate,
      logger: createTestLogger(),
    });

    await expect(registry.updateMetadata("missing-id", { a: 1 })).resolves.toBeUndefined();
  });
});

describe("managed process reaper daemon ownership", () => {
  const DAEMON_PID = 900;

  function daemonOwnerSnapshot(
    overrides: Partial<ManagedProcessSnapshot> = {},
  ): ManagedProcessSnapshot {
    return {
      pid: DAEMON_PID,
      commandLine: "node paseo-daemon",
      startedAt: null,
      startTimeTicks: "555",
      bootId: "boot-abc",
      ...overrides,
    };
  }

  function childSnapshot(pid: number): ManagedProcessSnapshot {
    return {
      pid,
      commandLine: "kimi-cod",
      startedAt: null,
      startTimeTicks: "111",
      bootId: "boot-abc",
    };
  }

  function ownerRegistry(
    paseoHome: string,
    processTable: ManagedProcessTable,
    terminator: FakeProcessTerminator,
    instanceId = "daemon-a",
  ) {
    return createManagedProcessRegistry({
      paseoHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      daemonOwner: { instanceId, pid: DAEMON_PID },
      readBootId: async () => "boot-abc",
    });
  }

  test("does not reap a process owned by another live daemon", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const ownerTable = new FakeProcessTable([daemonOwnerSnapshot(), childSnapshot(4201)]);
    const owner = ownerRegistry(tempHome, ownerTable, terminator);
    await owner.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4201,
      command: "kimi",
      args: ["acp"],
    });

    // A second daemon reconciles the shared ledger while the first is alive.
    const otherTable = new FakeProcessTable([daemonOwnerSnapshot(), childSnapshot(4201)]);
    const other = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: otherTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      daemonOwner: { instanceId: "daemon-b", pid: 901 },
      readBootId: async () => "boot-abc",
    });
    const result = await other.reapStale();

    expect(result).toMatchObject({ checked: 1, terminated: 0, removed: 0 });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await other.list()).toHaveLength(1);
  });

  test("reaps a child once the owning daemon is dead", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const ownerTable = new FakeProcessTable([daemonOwnerSnapshot(), childSnapshot(4202)]);
    const owner = ownerRegistry(tempHome, ownerTable, terminator);
    await owner.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4202,
      command: "kimi",
      args: ["acp"],
    });

    // Owner pid 900 is gone; the child is still alive.
    const reaper = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([childSnapshot(4202)]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    const result = await reaper.reapStale();

    expect(result).toMatchObject({ checked: 1, terminated: 1, removed: 1 });
    expect(terminator.terminatedPids).toEqual([4202]);
  });

  test("reaps a child when the owner pid was reused by a foreign process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const ownerTable = new FakeProcessTable([daemonOwnerSnapshot(), childSnapshot(4203)]);
    const owner = ownerRegistry(tempHome, ownerTable, terminator);
    await owner.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4203,
      command: "kimi",
      args: ["acp"],
    });

    const reaper = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        // Same pid, different start ticks: the daemon is gone and some other
        // process now owns pid 900.
        daemonOwnerSnapshot({ startTimeTicks: "999", commandLine: "unrelated" }),
        childSnapshot(4203),
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-abc",
    });
    const result = await reaper.reapStale();

    expect(result).toMatchObject({ checked: 1, terminated: 1, removed: 1 });
    expect(terminator.terminatedPids).toEqual([4203]);
  });

  test("reaps a record from a previous boot even when the owner pid looks alive", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const ownerTable = new FakeProcessTable([daemonOwnerSnapshot(), childSnapshot(4204)]);
    const owner = ownerRegistry(tempHome, ownerTable, terminator);
    await owner.record({
      owner: { provider: "acp", kind: "acp-agent" },
      pid: 4204,
      command: "kimi",
      args: ["acp"],
    });

    const reaper = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { ...daemonOwnerSnapshot(), bootId: "boot-xyz" },
        { ...childSnapshot(4204), bootId: "boot-xyz" },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
      readBootId: async () => "boot-xyz",
    });
    const result = await reaper.reapStale();

    // The owner classification is stale (previous boot), but the child check
    // independently refuses the kill: pid 4204 under the new boot is not the
    // recorded process.
    expect(result).toMatchObject({ checked: 1, mismatched: 1, terminated: 0, removed: 1 });
    expect(terminator.terminatedPids).toEqual([]);
  });
});
