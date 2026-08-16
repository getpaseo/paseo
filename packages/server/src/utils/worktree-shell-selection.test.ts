import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const spawnProcessMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

vi.mock("./spawn.js", async () => {
  const actual = await vi.importActual<typeof import("./spawn.js")>("./spawn.js");
  return {
    ...actual,
    spawnProcess: spawnProcessMock,
  };
});

function emitSuccessfulClose(child: ChildProcess): void {
  child.emit("close", 0);
}

function createSpawnChildStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    emitSuccessfulClose(child);
  });
  return child;
}

async function captureBoundSetupArgv(
  resolveCommand: (command: string) => Promise<string | null>,
): Promise<readonly string[]> {
  const run = vi.fn(async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.end();
    stderr.end();
    return {
      stdin: new PassThrough(),
      stdout,
      stderr,
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: vi.fn(),
    };
  });
  const { runWorktreeSetupCommands } = await import("./worktree.js");
  await runWorktreeSetupCommands({
    worktreePath: "/workspace",
    branchName: "runtime-branch",
    cleanupOnFailure: false,
    execution: {
      readFile: async () =>
        Buffer.from(JSON.stringify({ worktree: { setup: ["printf runtime-shell"] } })),
      resolveCommand,
      run,
    },
  });
  return run.mock.calls[0]![0].argv;
}

describe("worktree shell selection", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileMock.mockReset();
    spawnProcessMock.mockReset();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback?: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback?.(null, "", "");
        return {};
      },
    );
    spawnProcessMock.mockImplementation(createSpawnChildStub);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    vi.resetModules();
  });

  it("routes teardown command execution through powershell on win32", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const worktreePath = mkdtempSync(join(tmpdir(), "worktree-shell-selection-"));
    const originalBashEnv = process.env.BASH_ENV;
    process.env.BASH_ENV = "should-not-leak";
    try {
      mkdirSync(join(worktreePath, ".git"), { recursive: true });
      writeFileSync(
        join(worktreePath, "paseo.json"),
        JSON.stringify({
          worktree: {
            teardown: ["Write-Output 'teardown'"],
          },
        }),
        "utf8",
      );

      const { runWorktreeTeardownCommands } = await import("./worktree.js");
      await runWorktreeTeardownCommands({
        worktreePath,
        repoRootPath: worktreePath,
        branchName: "main",
      });

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Write-Output 'teardown'",
        ],
        expect.objectContaining({ cwd: worktreePath }),
        expect.any(Function),
      );
      const execOptions = execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(execOptions.env?.BASH_ENV).toBeUndefined();
    } finally {
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("routes streamed setup command execution through powershell on win32", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const worktreePath = mkdtempSync(join(tmpdir(), "worktree-shell-selection-"));
    const originalBashEnv = process.env.BASH_ENV;
    process.env.BASH_ENV = "should-not-leak";
    try {
      writeFileSync(
        join(worktreePath, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: ["Write-Output 'setup'"],
          },
        }),
        "utf8",
      );

      const { runWorktreeSetupCommands } = await import("./worktree.js");
      await runWorktreeSetupCommands({
        worktreePath,
        branchName: "main",
        cleanupOnFailure: false,
        runtimeEnv: {
          PASEO_SOURCE_CHECKOUT_PATH: worktreePath,
          PASEO_ROOT_PATH: worktreePath,
          PASEO_WORKTREE_PATH: worktreePath,
          PASEO_BRANCH_NAME: "main",
          PASEO_WORKTREE_PORT: "12345",
        },
        onEvent: () => {},
      });

      expect(spawnProcessMock).toHaveBeenCalledTimes(1);
      expect(spawnProcessMock).toHaveBeenCalledWith(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Write-Output 'setup'",
        ],
        expect.objectContaining({ cwd: worktreePath, shell: false }),
      );
      const spawnOptions = spawnProcessMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env?.BASH_ENV).toBeUndefined();
    } finally {
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("selects the bound runtime shell by capability instead of the host platform", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const run = vi.fn(async () => {
      stdout.end("runtime shell\n");
      stderr.end();
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: vi.fn(),
      };
    });
    const { runWorktreeSetupCommands } = await import("./worktree.js");
    const results = await runWorktreeSetupCommands({
      worktreePath: "/workspace",
      branchName: "runtime-branch",
      cleanupOnFailure: false,
      execution: {
        readFile: async () =>
          Buffer.from(JSON.stringify({ worktree: { setup: ["printf runtime-shell"] } })),
        resolveCommand: async (command) => (command === "bash" ? "/runtime/bin/bash" : null),
        run,
      },
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["/runtime/bin/bash", "-c", "printf runtime-shell"],
        cwd: "/workspace",
      }),
    );
    expect(results).toMatchObject([{ stdout: "runtime shell\n", exitCode: 0 }]);
    expect(spawnProcessMock).not.toHaveBeenCalled();
  });

  it("prefers PowerShell when the runtime exposes Windows and POSIX shells", async () => {
    const argv = await captureBoundSetupArgv(async (command) => `/runtime/bin/${command}`);
    expect(argv).toEqual([
      "/runtime/bin/powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "printf runtime-shell",
    ]);
  });

  it("falls back to cmd when a Windows runtime has no PowerShell", async () => {
    const argv = await captureBoundSetupArgv(async (command) =>
      command === "cmd.exe" ? "C:\\Windows\\System32\\cmd.exe" : null,
    );
    expect(argv).toEqual(["C:\\Windows\\System32\\cmd.exe", "/c", "printf runtime-shell"]);
  });
});
