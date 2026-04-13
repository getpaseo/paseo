import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeSpawnBehavior {
  delayMs?: number;
  emitError?: Error;
  exitCode?: number | null;
  stderrData?: Buffer | string;
  stdoutData?: Buffer | string;
}

interface FakeSpawnController {
  activeCount: number;
  nextPid: number;
  peakActiveCount: number;
  processes: FakeChildProcess[];
  queue: FakeSpawnBehavior[];
  reset: () => void;
}

const fakeSpawnController = vi.hoisted<FakeSpawnController>(() => ({
  activeCount: 0,
  nextPid: 1000,
  peakActiveCount: 0,
  processes: [],
  queue: [],
  reset() {
    for (const process of this.processes) {
      process.dispose();
    }

    this.activeCount = 0;
    this.nextPid = 1000;
    this.peakActiveCount = 0;
    this.processes = [];
    this.queue = [];
  },
}));

class FakeChildProcess extends EventEmitter {
  public readonly pid: number;
  public readonly stderr = new EventEmitter();
  public readonly stdout = new EventEmitter();
  public killed = false;
  public killSignals: NodeJS.Signals[] = [];

  private readonly behavior: FakeSpawnBehavior;
  private readonly timers: NodeJS.Timeout[] = [];
  private closed = false;

  public constructor(behavior: FakeSpawnBehavior) {
    super();
    this.behavior = behavior;
    this.pid = fakeSpawnController.nextPid;
    fakeSpawnController.nextPid += 1;

    fakeSpawnController.activeCount += 1;
    fakeSpawnController.peakActiveCount = Math.max(
      fakeSpawnController.peakActiveCount,
      fakeSpawnController.activeCount,
    );

    this.scheduleLifecycle();
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.closed) return false;

    this.killed = true;
    this.killSignals.push(signal);
    this.clearTimers();
    this.schedule(() => {
      this.finishClose({
        exitCode: null,
        signal,
      });
    }, 0);
    return true;
  }

  public dispose(): void {
    this.clearTimers();
    this.closed = true;
  }

  private scheduleLifecycle(): void {
    const stdoutData = this.behavior.stdoutData;
    if (stdoutData !== undefined) {
      this.schedule(() => {
        if (this.closed) return;
        this.stdout.emit("data", stdoutData);
      }, 0);
    }

    const stderrData = this.behavior.stderrData;
    if (stderrData !== undefined) {
      this.schedule(() => {
        if (this.closed) return;
        this.stderr.emit("data", stderrData);
      }, 0);
    }

    if (this.behavior.emitError) {
      this.schedule(() => {
        if (this.closed) return;
        this.finishError(this.behavior.emitError);
      }, this.behavior.delayMs ?? 0);
      return;
    }

    this.schedule(() => {
      this.finishClose({
        exitCode: this.behavior.exitCode ?? 0,
        signal: null,
      });
    }, this.behavior.delayMs ?? 0);
  }

  private finishClose({
    exitCode,
    signal,
  }: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    if (this.closed) return;

    this.closed = true;
    this.clearTimers();
    fakeSpawnController.activeCount -= 1;
    this.emit("close", exitCode, signal);
  }

  private finishError(error: Error): void {
    if (this.closed) return;

    this.closed = true;
    this.clearTimers();
    fakeSpawnController.activeCount -= 1;
    this.emit("error", error);
  }

  private schedule(callback: () => void, delayMs: number): void {
    const timer = setTimeout(callback, delayMs);
    this.timers.push(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.length = 0;
  }
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

  return {
    ...actual,
    spawn: vi.fn(() => {
      const behavior = fakeSpawnController.queue.shift() ?? {};
      const child = new FakeChildProcess(behavior);
      fakeSpawnController.processes.push(child);
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

function enqueueSpawnBehaviors(...behaviors: FakeSpawnBehavior[]): void {
  fakeSpawnController.queue.push(...behaviors);
}

async function loadRunGitCommand(concurrency: number) {
  vi.resetModules();
  vi.stubEnv("PASEO_GIT_CONCURRENCY", String(concurrency));
  return import("./run-git-command.js");
}

describe("runGitCommand", () => {
  beforeEach(() => {
    fakeSpawnController.reset();
  });

  afterEach(() => {
    fakeSpawnController.reset();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("throttles concurrent git commands to the configured limit", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors(...Array.from({ length: 16 }, () => ({ delayMs: 25 })));

    await Promise.all(
      Array.from({ length: 16 }, () =>
        runGitCommand(["rev-parse", "--show-toplevel"], {
          cwd: process.cwd(),
        }),
      ),
    );

    expect(fakeSpawnController.peakActiveCount).toBe(2);
    expect(fakeSpawnController.activeCount).toBe(0);
  });

  it("kills timed out processes and releases the limiter slot", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({ delayMs: 5_000 }, { delayMs: 0 });

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
        timeout: 100,
      }),
    ).rejects.toThrow("Git command timed out after 100ms: git status");

    expect(fakeSpawnController.processes[0]?.killed).toBe(true);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);

    await expect(
      runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      truncated: false,
    });
  });

  it("resolves truncated stdout, caps output, and kills the child process", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({
      delayMs: 5_000,
      stdoutData: "x".repeat(1_000),
    });

    const result = await runGitCommand(["log", "--all", "--oneline"], {
      cwd: process.cwd(),
      maxOutputBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.stderr).toBe("");
    expect(fakeSpawnController.processes[0]?.killed).toBe(true);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
  });

  it("rejects process errors and frees the limiter for the next command", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors(
      { emitError: new Error("spawn exploded") },
      { delayMs: 0, stdoutData: "ok" },
    );

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("spawn exploded");

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
      truncated: false,
    });
  });

  it("rejects non-zero exit codes that are not accepted and frees the slot", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors(
      {
        delayMs: 0,
        exitCode: 1,
        stderrData: "fatal: nope\n",
      },
      { delayMs: 0, stdoutData: "ok" },
    );

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/Git command failed: git status \(exit code: 1, signal: none\)/);

    await expect(
      runGitCommand(["status"], {
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok",
    });
  });

  it("resolves accepted non-zero exit codes", async () => {
    const { runGitCommand } = await loadRunGitCommand(1);

    enqueueSpawnBehaviors({
      delayMs: 0,
      exitCode: 1,
      stderrData: "fatal: but allowed\n",
    });

    await expect(
      runGitCommand(["status"], {
        acceptExitCodes: [0, 1],
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      signal: null,
      truncated: false,
    });
  });

  it("releases concurrency slots after timeouts so later commands can run", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors({ delayMs: 5_000 }, { delayMs: 5_000 });

    const firstBatch = await Promise.allSettled([
      runGitCommand(["status"], { cwd: process.cwd(), timeout: 100 }),
      runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
        timeout: 100,
      }),
    ]);

    expect(firstBatch[0].status).toBe("rejected");
    expect(firstBatch[1].status).toBe("rejected");
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
    expect(fakeSpawnController.processes[1]?.killSignals).toEqual(["SIGKILL"]);

    enqueueSpawnBehaviors(
      { delayMs: 0, stdoutData: "third" },
      { delayMs: 0, stdoutData: "fourth" },
    );

    await expect(
      Promise.all([
        runGitCommand(["status"], { cwd: process.cwd() }),
        runGitCommand(["status"], { cwd: process.cwd() }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ exitCode: 0, stdout: "third" }),
      expect.objectContaining({ exitCode: 0, stdout: "fourth" }),
    ]);
  });

  it("releases concurrency slots after truncation so later commands can run", async () => {
    const { runGitCommand } = await loadRunGitCommand(2);

    enqueueSpawnBehaviors(
      { delayMs: 5_000, stdoutData: "a".repeat(1_000) },
      { delayMs: 5_000, stdoutData: "b".repeat(1_000) },
    );

    const firstBatch = await Promise.all([
      runGitCommand(["log", "--all", "--oneline"], {
        cwd: process.cwd(),
        maxOutputBytes: 100,
      }),
      runGitCommand(["log", "--all", "--oneline"], {
        cwd: process.cwd(),
        maxOutputBytes: 100,
      }),
    ]);

    expect(firstBatch).toEqual([
      expect.objectContaining({ truncated: true }),
      expect.objectContaining({ truncated: true }),
    ]);
    expect(fakeSpawnController.processes[0]?.killSignals).toEqual(["SIGKILL"]);
    expect(fakeSpawnController.processes[1]?.killSignals).toEqual(["SIGKILL"]);

    enqueueSpawnBehaviors(
      { delayMs: 0, stdoutData: "third" },
      { delayMs: 0, stdoutData: "fourth" },
    );

    await expect(
      Promise.all([
        runGitCommand(["status"], { cwd: process.cwd() }),
        runGitCommand(["status"], { cwd: process.cwd() }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ exitCode: 0, stdout: "third", truncated: false }),
      expect.objectContaining({ exitCode: 0, stdout: "fourth", truncated: false }),
    ]);
  });
});
