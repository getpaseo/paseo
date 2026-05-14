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

vi.mock("@getpaseo/server", () => ({
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

  it("bounds captured stdout from text commands", async () => {
    const suffix = "daemon still running\n";
    const largeOutput = `${"x".repeat(512 * 1024)}${suffix}`;
    mockExternalCliOutput({ stdout: largeOutput });

    const output = await runExternalCliTextCommand(["daemon", "status"]);

    expect(output.length).toBeLessThanOrEqual(64 * 1024);
    expect(output.endsWith(suffix.trimEnd())).toBe(true);
  });

  it("bounds captured stderr in failure messages", async () => {
    const suffix = "fatal: daemon exploded\n";
    mockExternalCliOutput({
      stdout: "",
      stderr: `${"x".repeat(512 * 1024)}${suffix}`,
      exitCode: 1,
    });

    await runExternalCliTextCommand(["daemon", "status"]).then(
      () => {
        throw new Error("Expected external CLI command to fail");
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain(`output truncated to the last ${64 * 1024} chars`);
        expect(message).toContain(suffix.trimEnd());
        expect(message.length).toBeLessThan(70 * 1024);
      },
    );
  });
});
