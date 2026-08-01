import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

import type { SpawnProcessOptions } from "../../../../utils/spawn.js";
import {
  createWindowsJobObjectProcessSpawner,
  getWindowsJobObjectProofMarker,
} from "./windows-job-object.js";

const liveSupervisors: ChildProcess[] = [];

afterEach(async () => {
  const cleanup = liveSupervisors.splice(0).map(async (supervisor) => {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      return;
    }
    supervisor.stdin?.write("terminate\n");
    await waitForExit(supervisor, 5_000).catch(() => supervisor.kill());
  });
  await Promise.all(cleanup);
});

describe("Windows Job Object process spawner", () => {
  test("passes the target environment and quoted command line to a hidden supervisor", () => {
    const child = createFakeChild();
    const calls: Array<{ command: string; args: string[]; options: SpawnProcessOptions }> = [];
    const spawn = createWindowsJobObjectProcessSpawner((command, args, options) => {
      calls.push({ command, args, options });
      return child;
    });

    expect(
      spawn(
        "C:\\Program Files\\OpenCode\\opencode.exe",
        ["serve", "two words", 'quote"value', ""],
        {
          cwd: "C:\\workspace",
          baseEnv: {
            HOME: "C:\\home",
            PASEO_SUPERVISED: "1",
            SHARED: "base",
          },
          envOverlay: { SHARED: "launch", TARGET_ONLY: "target" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ).toBe(child);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("powershell.exe");
    expect(call.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(call.args[4]!.length).toBeLessThan(32_000);
    expect(call.options).toMatchObject({
      cwd: "C:\\workspace",
      envMode: "internal",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: "C:\\home", SHARED: "launch", TARGET_ONLY: "target" },
    });
    expect(call.options.env).not.toHaveProperty("PASEO_SUPERVISED");
    expect(call.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND).toBe(
      "C:\\Program Files\\OpenCode\\opencode.exe",
    );
    expect(
      Buffer.from(call.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND_LINE ?? "", "base64").toString(
        "utf8",
      ),
    ).toBe('"C:\\Program Files\\OpenCode\\opencode.exe" serve "two words" "quote\\"value" ""');
    expect(call.options.envOverlay?.PASEO_WINDOWS_JOB_PROOF).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/u,
    );
    expect(getWindowsJobObjectProofMarker(child)).toBe(
      `PASEO_WINDOWS_JOB_EMPTY:${call.options.envOverlay?.PASEO_WINDOWS_JOB_PROOF}`,
    );
  });

  test.runIf(process.platform === "win32")(
    "keeps a generation alive after its leader exits and kills its surviving descendant",
    async () => {
      const target = [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
        '  detached: true, stdio: "ignore"',
        "});",
        "console.log(`descendant:${child.pid}`);",
        "child.unref();",
      ].join("\n");
      const spawn = createWindowsJobObjectProcessSpawner();
      const supervisor = spawn(process.execPath, ["-e", target], {
        envMode: "internal",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      liveSupervisors.push(supervisor);

      const line = await waitForOutput(supervisor, "descendant:", 10_000);
      const descendantPid = Number(line.match(/descendant:(\d+)/u)?.[1]);
      expect(Number.isInteger(descendantPid)).toBe(true);
      await waitForProcessState(descendantPid, true, 5_000);

      expect(supervisor.exitCode).toBe(null);
      expect(supervisor.stdin?.write("terminate\n")).toBe(true);
      await waitForExit(supervisor, 10_000);
      await waitForProcessState(descendantPid, false, 5_000);
    },
    30_000,
  );
});

function createFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function waitForOutput(process: ChildProcess, marker: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Windows supervisor output: ${output}`));
    }, timeoutMs);
    const onData = (data: Buffer) => {
      output += data.toString();
      const line = output.split(/\r?\n/u).find((candidate) => candidate.includes(marker));
      if (line) {
        cleanup();
        resolve(line);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`Windows supervisor exited before output: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdout?.off("data", onData);
      process.off("exit", onExit);
    };
    process.stdout?.on("data", onData);
    process.on("exit", onExit);
  });
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("exit", onExit);
      reject(new Error("Timed out waiting for Windows supervisor exit"));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    process.once("exit", onExit);
  });
}

async function waitForProcessState(pid: number, expectedAlive: boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isProcessAlive(pid) === expectedAlive) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} did not become ${expectedAlive ? "alive" : "dead"}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
