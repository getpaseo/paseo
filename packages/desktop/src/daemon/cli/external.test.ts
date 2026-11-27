import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./external";

const mocks = vi.hoisted(() => ({
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: ["runner.js", "node-script", "cli.js"],
    env: { PASEO_NODE_ENV: "production" },
  })),
  resolveExternalCliEntrypoint: vi.fn(() => ({
    entryPath: "cli.js",
    execArgv: [],
  })),
  spawnProcess: vi.fn(),
}));

vi.mock("@getpaseo/server/process", () => ({
  spawnProcess: mocks.spawnProcess,
}));

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

vi.mock("../runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
}));

vi.mock("./entrypoints.js", () => ({
  resolveExternalCliEntrypoint: mocks.resolveExternalCliEntrypoint,
}));

function mockExternalCliOutput(input: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}): void {
  mocks.spawnProcess.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      if (input.stdout.length > 0) {
        child.stdout.emit("data", Buffer.from(input.stdout));
      }
      if (input.stderr && input.stderr.length > 0) {
        child.stderr.emit("data", Buffer.from(input.stderr));
      }
      child.emit("close", input.exitCode ?? 0);
    });

    return child;
  });
}

describe("external CLI", () => {
  it("runs text commands through an isolated CLI process", async () => {
    mockExternalCliOutput({ stdout: "daemon running\n" });

    await expect(runExternalCliTextCommand(["daemon", "status"])).resolves.toBe("daemon running");

    expect(mocks.createNodeEntrypointInvocation).toHaveBeenCalledWith({
      entrypoint: { entryPath: "cli.js", execArgv: [] },
      argvMode: "node-script",
      args: ["daemon", "status"],
      baseEnv: process.env,
    });
    expect(mocks.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["runner.js", "node-script", "cli.js"],
      {
        envMode: "internal",
        env: { PASEO_NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("parses JSON output from an isolated CLI process", async () => {
    mockExternalCliOutput({ stdout: '{"localDaemon":"running"}\n' });

    await expect(runExternalCliJsonCommand(["daemon", "status", "--json"])).resolves.toEqual({
      localDaemon: "running",
    });
  });

  it("terminates and rejects when an external CLI subprocess hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: typeof kill;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = kill;
      mocks.spawnProcess.mockReturnValueOnce(child);

      const pending = runExternalCliJsonCommand(["daemon", "status", "--json"]);
      const assertion = expect(pending).rejects.toThrow(
        "CLI command timed out after 15000ms: daemon status --json",
      );

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
