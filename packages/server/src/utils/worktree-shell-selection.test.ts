import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("worktree shell selection", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileMock.mockReset();
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
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
