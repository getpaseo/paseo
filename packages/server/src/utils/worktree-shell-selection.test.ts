import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  queueMicrotask(() => emitSuccessfulClose(child));
  return child;
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
});
