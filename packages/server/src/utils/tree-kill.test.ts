import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createTreeKillTerminator,
  parseProcStat,
  parsePsProcessTable,
  readProcessTable,
  selectAttachedProcessTree,
  terminateWithTreeKill,
  type ProcessTableEntry,
  type TreeKillTarget,
} from "./tree-kill.js";

const pollIntervalMs = 50;

let tempDir: string | null = null;
let ownerProcess: ChildProcess | null = null;
let descendantPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }
  return poll();
}

async function readPidFileNumber(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killIfRunning(pid: number | null | undefined): void {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup races.
  }
}

function spawnOwnerWithDescendant(options: {
  childPidPath: string;
  detachedDescendant: boolean;
  ownerExitsOnSigterm?: boolean;
  descendantIgnoresSigterm?: boolean;
}): ChildProcess {
  const descendantOptions = options.detachedDescendant
    ? '{ detached: true, stdio: "ignore" }'
    : '{ stdio: "ignore" }';
  const childUnref = options.detachedDescendant ? "child.unref();" : "";
  const ownerSigterm = options.ownerExitsOnSigterm ? "process.exit(0)" : "";
  const descendantSigterm = options.descendantIgnoresSigterm === false ? "process.exit(0)" : "";

  return spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => { ${ownerSigterm} });
        const child = spawn(process.execPath, [
          "-e",
          ${JSON.stringify(`
            const fs = require("node:fs");
            process.on("SIGTERM", () => { ${descendantSigterm} });
            fs.writeFileSync(${JSON.stringify(options.childPidPath)}, String(process.pid));
            setInterval(() => {}, 1000);
          `)}
        ], ${descendantOptions});
        ${childUnref}
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: "ignore" },
  );
}

async function waitForFixtureReady(childPidPath: string): Promise<void> {
  await waitFor(
    async () => {
      descendantPid = await readPidFileNumber(childPidPath);
      return (
        isProcessRunning(ownerProcess?.pid ?? -1) &&
        descendantPid !== null &&
        isProcessRunning(descendantPid)
      );
    },
    5000,
    "owner descendant did not become running in time",
  );
}

async function expectOwnerAndDescendantStopped(message: string): Promise<void> {
  await waitFor(
    () => !isProcessRunning(ownerProcess?.pid ?? -1) && !isProcessRunning(descendantPid ?? -1),
    5000,
    message,
  );
}

afterEach(async () => {
  killIfRunning(ownerProcess?.pid);
  killIfRunning(descendantPid);
  ownerProcess = null;
  descendantPid = null;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("terminateWithTreeKill", () => {
  test.runIf(process.platform === "win32")(
    "kills Windows descendants through taskkill tree cleanup",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // tree-kill uses taskkill /T /F on Windows, so the first signal is already forceful.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped(
        "owner or Windows descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills descendants that started their own process group",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or separate-process-group descendant survived terminateWithTreeKill",
      );
    },
  );
});

describe("terminateWithTreeKill detached descendants", () => {
  test.runIf(process.platform !== "win32")(
    "spares a setsid descendant from the graceful signal",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
        ownerExitsOnSigterm: true,
        descendantIgnoresSigterm: false,
      });
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("terminated");
      await waitFor(() => !isProcessRunning(ownerProcess?.pid ?? -1), 5000, "owner survived");
      // The descendant exits on SIGTERM, so still running means it was never signalled.
      await sleep(300);
      expect(isProcessRunning(descendantPid ?? -1)).toBe(true);
    },
  );

  test.runIf(process.platform !== "win32")(
    "still signals a same-session descendant gracefully",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
        ownerExitsOnSigterm: true,
        descendantIgnoresSigterm: false,
      });
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // No force signal was sent, so the descendant went on the graceful one.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped("owner or same-session descendant survived");
    },
  );

  test.runIf(process.platform !== "win32")(
    "spares a setsid descendant from the force signal when asked",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
        spareDetachedOnForce: true,
      });

      expect(result).toBe("killed");
      await waitFor(() => !isProcessRunning(ownerProcess?.pid ?? -1), 5000, "owner survived");
      expect(isProcessRunning(descendantPid ?? -1)).toBe(true);
    },
  );

  test.runIf(process.platform !== "win32")(
    "reads this process from the process table",
    async () => {
      const table = await readProcessTable();

      expect(table).not.toBeNull();
      expect(table).toContainEqual(
        expect.objectContaining({ pid: process.pid, ppid: process.ppid }),
      );
    },
  );
});

// Fake process table, rooted at 100:
//   100 agent
//   ├── 110 shell          (same session)
//   │   └── 111 tool       (same session, own process group via job control)
//   └── 120 shared daemon  (setsid)
//       └── 121 worker
const fakeTable: ProcessTableEntry[] = [
  { pid: 1, ppid: 0, sessionLeader: true },
  { pid: 100, ppid: 1, sessionLeader: false },
  { pid: 110, ppid: 100, sessionLeader: false },
  { pid: 111, ppid: 110, sessionLeader: false },
  { pid: 120, ppid: 100, sessionLeader: true },
  { pid: 121, ppid: 120, sessionLeader: false },
  { pid: 200, ppid: 1, sessionLeader: false },
];

class FakeProcessTree {
  readonly signals: Array<[number, NodeJS.Signals]> = [];
  readonly treeSignals: NodeJS.Signals[] = [];
  exitOn: NodeJS.Signals | null = null;
  table: ProcessTableEntry[] | null = fakeTable;
  tableError: Error | null = null;
  private exitListener: (() => void) | null = null;

  readonly target: TreeKillTarget = {
    pid: 100,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    once: (_event, listener) => {
      this.exitListener = listener;
    },
  };

  readonly terminate = createTreeKillTerminator({
    readProcessTable: async () => {
      if (this.tableError) throw this.tableError;
      return this.table;
    },
    signalPid: (pid, signal) => {
      this.signals.push([pid, signal]);
      if (pid === 100) this.maybeExit(signal);
    },
    signalTree: async (_child, signal) => {
      this.treeSignals.push(signal);
      this.maybeExit(signal);
    },
  });

  signalled(signal: NodeJS.Signals): number[] {
    return this.signals.filter(([, sent]) => sent === signal).map(([pid]) => pid);
  }

  private maybeExit(signal: NodeJS.Signals): void {
    if (signal === this.exitOn) {
      this.target.signalCode = signal;
      this.exitListener?.();
    }
  }
}

describe("createTreeKillTerminator", () => {
  test("gracefully signals the root and same-session descendants only", async () => {
    const tree = new FakeProcessTree();
    tree.exitOn = "SIGTERM";

    const result = await tree.terminate(tree.target, { gracefulTimeoutMs: 50 });

    expect(result).toBe("terminated");
    expect(tree.signalled("SIGTERM")).toEqual([100, 110, 111]);
    expect(tree.treeSignals).toEqual([]);
  });

  test("reaps detached descendants on force by default", async () => {
    const tree = new FakeProcessTree();
    tree.exitOn = "SIGKILL";

    const result = await tree.terminate(tree.target, {
      gracefulTimeoutMs: 10,
      forceTimeoutMs: 50,
    });

    expect(result).toBe("killed");
    expect(tree.signalled("SIGTERM")).toEqual([100, 110, 111]);
    expect(tree.treeSignals).toEqual(["SIGKILL"]);
  });

  test("spares detached descendants on force when asked", async () => {
    const tree = new FakeProcessTree();
    tree.exitOn = "SIGKILL";

    const result = await tree.terminate(tree.target, {
      gracefulTimeoutMs: 10,
      forceTimeoutMs: 50,
      spareDetachedOnForce: true,
    });

    expect(result).toBe("killed");
    expect(tree.signalled("SIGKILL")).toEqual([100, 110, 111]);
    expect(tree.treeSignals).toEqual([]);
  });

  test("falls back to the whole tree when the process table is unavailable", async () => {
    const tree = new FakeProcessTree();
    tree.table = null;
    tree.exitOn = "SIGTERM";

    const result = await tree.terminate(tree.target, { gracefulTimeoutMs: 50 });

    expect(result).toBe("terminated");
    expect(tree.signals).toEqual([]);
    expect(tree.treeSignals).toEqual(["SIGTERM"]);
  });

  test("falls back to the whole tree when reading the process table throws", async () => {
    const tree = new FakeProcessTree();
    tree.tableError = new Error("ps: command not found");
    tree.exitOn = "SIGTERM";

    const result = await tree.terminate(tree.target, { gracefulTimeoutMs: 50 });

    expect(result).toBe("terminated");
    expect(tree.signals).toEqual([]);
    expect(tree.treeSignals).toEqual(["SIGTERM"]);
  });
});

describe("selectAttachedProcessTree", () => {
  test("prunes session leaders and their subtrees", () => {
    expect(selectAttachedProcessTree(fakeTable, 100)).toEqual([100, 110, 111]);
  });

  test("keeps a root that leads its own session", () => {
    const table = fakeTable.map((entry) =>
      entry.pid === 100 ? { ...entry, sessionLeader: true } : entry,
    );
    expect(selectAttachedProcessTree(table, 100)).toEqual([100, 110, 111]);
  });

  test("returns the root alone when it is missing from the table", () => {
    expect(selectAttachedProcessTree(fakeTable, 999)).toEqual([999]);
  });
});

describe("process table parsing", () => {
  test("parses /proc stat lines with spaces and parentheses in comm", () => {
    expect(parseProcStat("4321 (jcode (acp) x) S 4000 4321 4321 0 -1 4194560")).toEqual({
      pid: 4321,
      ppid: 4000,
      sessionLeader: true,
    });
    expect(parseProcStat("4322 (bash) S 4321 4322 4000 0 -1")).toEqual({
      pid: 4322,
      ppid: 4321,
      sessionLeader: false,
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  test("parses ps output and reads session leadership from STAT", () => {
    expect(parsePsProcessTable("    1     0 Ss  \n  500     1 Ssl\n  501   500 S+\n\n")).toEqual([
      { pid: 1, ppid: 0, sessionLeader: true },
      { pid: 500, ppid: 1, sessionLeader: true },
      { pid: 501, ppid: 500, sessionLeader: false },
    ]);
  });
});
