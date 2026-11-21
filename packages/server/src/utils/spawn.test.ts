import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildSelfNodeCommand } from "../server/paseo-env.js";
import { settleSpawnCommandResolutions } from "./resolve-spawn-command.js";
import { execCommand, spawnProcess } from "./spawn.js";

const printEnvScript = `
const keys = [
  "CUSTOM",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_RUN_AS_NODE",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_NODE_ENV",
  "PASEO_SUPERVISED",
];
const values = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
console.log(JSON.stringify(values));
`;

function parsePrintedEnv(stdout: string): Record<string, string | null> {
  return JSON.parse(stdout.trim()) as Record<string, string | null>;
}

describe("execCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns stdout and stderr for a successful command", async () => {
    const result = await execCommand("echo", ["hello"]);

    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("rejects when the command times out", async () => {
    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10_000)"],
          }
        : { command: "sleep", args: ["10"] };

    await expect(execCommand(command.command, command.args, { timeout: 100 })).rejects.toThrow();
  });

  test("runs the command in the provided cwd", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-test-")));
    tempDirs.push(cwd);

    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "console.log(process.cwd())"],
          }
        : { command: "pwd", args: [] };

    const result = await execCommand(command.command, command.args, { cwd });

    expect(realpathSync(result.stdout.trim())).toBe(cwd);
    expect(result.stderr).toBe("");
  });

  test("treats env as the replacement base and finalizes external command env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "0",
        CUSTOM: "from-base",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
        PASEO_SUPERVISED: "1",
      },
      env: {
        CUSTOM: "from-env",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        PASEO_DESKTOP_MANAGED: "1",
        PASEO_NODE_ENV: "test",
      },
      envOverlay: {
        CUSTOM: "from-overlay",
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "from-overlay",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: null,
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });

  test("does not inherit process.env when env replacement is supplied", async () => {
    process.env.PASEO_TEST_SHOULD_NOT_LEAK = "leaked";
    try {
      const result = await execCommand(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ leaked: process.env.PASEO_TEST_SHOULD_NOT_LEAK ?? null }))",
        ],
        {
          env: {
            PATH: process.env.PATH,
          },
        },
      );

      expect(JSON.parse(result.stdout.trim())).toEqual({ leaked: null });
    } finally {
      delete process.env.PASEO_TEST_SHOULD_NOT_LEAK;
    }
  });

  test("spawnProcess finalizes external command env", async () => {
    const child = spawnProcess(process.execPath, ["-e", printEnvScript], {
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "0",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
      },
      envOverlay: {
        CUSTOM: "spawn-overlay",
        PASEO_SUPERVISED: "1",
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(Buffer.concat(stderrChunks).toString()).toBe("");
    expect(exitCode).toBe(0);
    expect(parsePrintedEnv(Buffer.concat(stdoutChunks).toString())).toEqual({
      CUSTOM: "spawn-overlay",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: null,
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });

  test("internal env mode preserves Paseo-owned launcher env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      envMode: "internal",
      baseEnv: {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: process.env.PATH,
        PASEO_NODE_ENV: "production",
      },
      envOverlay: {
        CUSTOM: "internal",
        PASEO_SUPERVISED: "1",
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "internal",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: "production",
      PASEO_SUPERVISED: "1",
    });
  });

  test("does not realpath commands while finalizing external command env", async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, "native");

    await execCommand("/some/random/binary", ["--version"], {
      env: {
        PATH: process.env.PATH,
      },
      timeout: 100,
    }).catch(() => {});

    expect(realpathSpy).not.toHaveBeenCalled();
  });

  test("self node command explicitly enables Electron node mode", async () => {
    const command = buildSelfNodeCommand(["-e", printEnvScript], {
      CUSTOM: "from-helper",
    });

    const result = await execCommand(command.command, command.args, {
      env: command.env,
      envMode: "internal",
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "from-helper",
      ELECTRON_NO_ATTACH_CONSOLE: null,
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_DESKTOP_MANAGED: null,
      PASEO_NODE_ENV: null,
      PASEO_SUPERVISED: null,
    });
  });
});

describe("spawnProcess", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function runToCompletion(
    child: ChildProcess,
  ): Promise<{ code: number | null; stdout: string }> {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout: Buffer.concat(chunks).toString() };
  }

  function createGitPath() {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-stale-path-")));
    tempDirs.push(root);
    const firstBin = path.join(root, "first");
    const secondBin = path.join(root, "second");
    const firstGit = path.join(firstBin, "git");
    const secondGit = path.join(secondBin, "git");
    fs.mkdirSync(firstBin);
    fs.mkdirSync(secondBin);
    fs.writeFileSync(firstGit, "#!/bin/sh\necho first\n", { mode: 0o755 });
    fs.writeFileSync(secondGit, "#!/bin/sh\necho second\n", { mode: 0o755 });
    return { firstGit, secondGit, env: { PATH: [firstBin, secondBin].join(path.delimiter) } };
  }

  // libuv on macOS finds a bare command by trying posix_spawn in each PATH directory, and every
  // miss runs on the event loop. Once spawnProcess knows where a command lives it hands libuv
  // that file instead.
  test.skipIf(process.platform === "win32")(
    "starts a bare command from its resolved PATH location, keeping argv[0]",
    async () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-path-")));
      tempDirs.push(root);
      const misses = Array.from({ length: 20 }, (_, index) => path.join(root, `miss-${index}`));
      for (const miss of misses) fs.mkdirSync(miss);
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const tool = path.join(bin, "paseo-spawn-test-tool");
      fs.writeFileSync(tool, "#!/bin/sh\necho tool-ran\n", { mode: 0o755 });
      const options = {
        env: { PATH: [...misses, bin, "/usr/bin", "/bin"].join(path.delimiter) },
        stdio: ["ignore", "pipe", "pipe"] as const,
      };

      const first = spawnProcess("paseo-spawn-test-tool", [], {
        ...options,
        stdio: [...options.stdio],
      });
      expect(await runToCompletion(first)).toEqual({ code: 0, stdout: "tool-ran\n" });
      await settleSpawnCommandResolutions();

      const second = spawnProcess("paseo-spawn-test-tool", [], {
        ...options,
        stdio: [...options.stdio],
      });
      expect(second.spawnfile).toBe(tool);
      expect(second.spawnargs[0]).toBe("paseo-spawn-test-tool");
      expect(await runToCompletion(second)).toEqual({ code: 0, stdout: "tool-ran\n" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "finds the next git on PATH after the cached executable is removed",
    async () => {
      const { firstGit, secondGit, env } = createGitPath();

      expect(await runToCompletion(spawnProcess("git", ["--version"], { env }))).toEqual({
        code: 0,
        stdout: "first\n",
      });
      await settleSpawnCommandResolutions();
      const cached = spawnProcess("git", ["--version"], { env });
      expect(cached.spawnfile).toBe(firstGit);
      expect(await runToCompletion(cached)).toEqual({ code: 0, stdout: "first\n" });

      fs.rmSync(firstGit);
      const retried = spawnProcess("git", ["--version"], { env });
      expect(await runToCompletion(retried)).toEqual({ code: 0, stdout: "second\n" });
      expect(retried.spawnfile).toBe("git");
      await settleSpawnCommandResolutions();
      const refreshed = spawnProcess("git", ["--version"], { env });
      expect(refreshed.spawnfile).toBe(secondGit);
      expect(await runToCompletion(refreshed)).toEqual({ code: 0, stdout: "second\n" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "only surfaces the bare spawn error if both attempts fail",
    async () => {
      const { firstGit, secondGit, env } = createGitPath();
      await runToCompletion(spawnProcess("git", [], { env }));
      await settleSpawnCommandResolutions();
      fs.rmSync(firstGit);
      fs.rmSync(secondGit);

      const unhandled = vi.fn();
      process.on("uncaughtExceptionMonitor", unhandled);
      try {
        const child = spawnProcess("git", [], { env });
        await expect(runToCompletion(child)).rejects.toMatchObject({ code: "ENOENT", path: "git" });
        expect(child.spawnfile).toBe("git");
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("uncaughtExceptionMonitor", unhandled);
        await settleSpawnCommandResolutions();
      }
    },
  );
});
