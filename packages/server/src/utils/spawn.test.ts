import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildSelfNodeCommand } from "../server/paseo-env.js";
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

  test("treats a zero timeout as disabled", async () => {
    const result = await execCommand(
      process.execPath,
      ["-e", "setTimeout(() => console.log('completed'), 25)"],
      { timeout: 0 },
    );

    expect(result.stdout.trim()).toBe("completed");
  });

  test("rejects invalid timeout and maxBuffer options before spawning", async () => {
    await expect(execCommand(process.execPath, ["-e", ""], { timeout: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(execCommand(process.execPath, ["-e", ""], { maxBuffer: -1 })).rejects.toThrow(
      RangeError,
    );
  });

  test.skipIf(process.platform === "win32")(
    "stops collecting output while terminating the process tree after maxBuffer",
    async () => {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-test-")));
      tempDirs.push(cwd);
      const pidFile = path.join(cwd, "descendant.pid");
      const descendantScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000);';
      const wrapperScript = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "inherit"] });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'process.on("SIGTERM", () => {});',
        'setInterval(() => process.stdout.write("x".repeat(1024)), 0);',
      ].join("");
      let descendantPid: number | undefined;

      try {
        await expect(
          execCommand(process.execPath, ["-e", wrapperScript], { maxBuffer: 1024 }),
        ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });

        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        descendantPid = pid;
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }
    },
  );

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
