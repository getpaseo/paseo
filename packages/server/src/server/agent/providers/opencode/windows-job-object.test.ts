import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";

import type { SpawnProcessOptions } from "../../../../utils/spawn.js";
import {
  __windowsJobObjectInternals,
  createWindowsJobObjectTerminationTarget,
  createWindowsJobObjectProcessSpawner,
  getWindowsJobObjectCompletion,
  getWindowsJobObjectLeaderExit,
  getWindowsJobObjectLeaderExitMarker,
  getWindowsJobObjectProofMarker,
} from "./windows-job-object.js";

const liveSupervisors: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  const cleanup = liveSupervisors.splice(0).map(async (supervisor) => {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
      return;
    }
    createWindowsJobObjectTerminationTarget(supervisor).kill();
    await waitForExit(supervisor, 5_000).catch(() => supervisor.kill());
  });
  await Promise.all(cleanup);
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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

  test.each([".cmd", ".bat"])(
    "launches an explicit Windows %s command through cmd.exe with escaped arguments",
    (extension) => {
      const child = createFakeChild();
      const calls: Array<{ command: string; args: string[]; options: SpawnProcessOptions }> = [];
      const spawn = createWindowsJobObjectProcessSpawner((spawnCommand, args, options) => {
        calls.push({ command: spawnCommand, args, options });
        return child;
      });
      const command = `C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode${extension}`;
      const targetArgs = ["serve", "two words", "x & whoami", "%PATH%", 'quote"'];

      spawn(command, targetArgs, {
        cwd: "C:\\workspace",
        envMode: "internal",
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", PATH: "do-not-expand" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const call = calls[0]!;
      expect(call.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND).toBe(
        "C:\\Windows\\System32\\cmd.exe",
      );
      const jobCommandLine = decodeBase64(call.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND_LINE);
      expect(jobCommandLine).toContain(" /d /v:off /s /c ");
      expect(jobCommandLine).toContain("x^ ^&^ whoami");
      expect(jobCommandLine).toContain(
        "%PASEO_WINDOWS_BATCH_LITERAL_PERCENT%PATH%PASEO_WINDOWS_BATCH_LITERAL_PERCENT%",
      );
      expect(call.options.env?.PASEO_WINDOWS_BATCH_LITERAL_PERCENT).toBe("%");
    },
  );

  test("resolves a bare Windows command against the target PATH and PATHEXT", () => {
    const child = createFakeChild();
    const calls: Array<{ command: string; args: string[]; options: SpawnProcessOptions }> = [];
    const resolutionCalls: Array<{ command: string; environment: Record<string, string> }> = [];
    const spawn = createWindowsJobObjectProcessSpawner(
      (spawnCommand, args, options) => {
        calls.push({ command: spawnCommand, args, options });
        return child;
      },
      undefined,
      (command, environment) => {
        resolutionCalls.push({ command, environment });
        return "C:\\provider-bin\\opencode.cmd";
      },
    );

    spawn("opencode", ["serve"], {
      envMode: "internal",
      env: { Path: "C:\\provider-bin", PathExt: ".EXE;.CMD;.BAT" },
    });

    expect(resolutionCalls).toEqual([
      {
        command: "opencode",
        environment: { Path: "C:\\provider-bin", PathExt: ".EXE;.CMD;.BAT" },
      },
    ]);
    expect(calls[0]?.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND).toBe("cmd.exe");
    expect(decodeBase64(calls[0]?.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND_LINE)).toContain(
      "C:\\provider-bin\\opencode.cmd",
    );
  });

  test("keeps non-native, non-batch commands on the data-only PowerShell argv bridge", () => {
    const child = createFakeChild();
    const calls: Array<{ command: string; args: string[]; options: SpawnProcessOptions }> = [];
    const spawn = createWindowsJobObjectProcessSpawner((spawnCommand, args, options) => {
      calls.push({ command: spawnCommand, args, options });
      return child;
    });
    const command = "C:\\provider\\launch.ps1";
    const targetArgs = ["two words", "x & whoami", "%PATH%", 'quote"'];

    spawn(command, targetArgs, {
      envMode: "internal",
      env: { PATH: "C:\\Windows\\System32" },
    });

    const call = calls[0]!;
    expect(call.options.envOverlay?.PASEO_WINDOWS_JOB_COMMAND).toBe("powershell.exe");
    expect(decodeBase64(call.options.env?.PASEO_WINDOWS_COMMAND_HOST_COMMAND)).toBe(command);
    expect(decodeBase64(call.options.env?.PASEO_WINDOWS_COMMAND_HOST_ARGUMENT_LINE)).toBe(
      '"two words" "x & whoami" %PATH% "quote\\\""',
    );
  });

  test("rejects oversized command lines and environment values before spawning", () => {
    const child = createFakeChild();
    const calls: string[] = [];
    const spawn = createWindowsJobObjectProcessSpawner((command) => {
      calls.push(command);
      return child;
    });

    expect(() =>
      spawn("C:\\opencode.exe", ["x".repeat(32_767)], {
        envMode: "internal",
        env: {},
      }),
    ).toThrow("Windows target command line exceeds 32767 characters");
    expect(() =>
      spawn("C:\\opencode.exe", [], {
        envMode: "internal",
        env: { TOO_LARGE: "x".repeat(32_767) },
      }),
    ).toThrow("Windows environment variable 'TOO_LARGE' exceeds 32767 characters");
    expect(() =>
      spawn("C:\\opencode.exe", [], {
        envMode: "internal",
        env: createOversizedEnvironmentBlock(),
      }),
    ).toThrow("Windows environment block exceeds 65536 characters");
    expect(() =>
      spawn("C:\\opencode.exe", ["bad\0argument"], {
        envMode: "internal",
        env: {},
      }),
    ).toThrow("Windows argument 0 contains a null character");
    expect(calls).toEqual([]);
  });

  test("settles a pre-spawn asynchronous error as an empty Job and leader exit", async () => {
    const child = createFakeChild();
    const spawn = createWindowsJobObjectProcessSpawner(() => child);
    const supervisor = spawn("C:\\opencode.exe", ["serve"], {
      envMode: "internal",
      env: {},
    });

    child.emit("error", new Error("spawn powershell.exe ENOENT"));

    await expect(getWindowsJobObjectCompletion(supervisor)).resolves.toBe(true);
    await expect(getWindowsJobObjectLeaderExit(supervisor)).resolves.toBe(1);
    expect(createWindowsJobObjectTerminationTarget(supervisor).kill()).toBe(false);
    child.emit("close", -1, null);
    await expect(getWindowsJobObjectCompletion(supervisor)).resolves.toBe(true);
  });

  test("waits for complete leader-exit records across adversarial chunk boundaries", async () => {
    const proofMarker = "PASEO_WINDOWS_JOB_EMPTY:test-proof";
    const leaderExitMarker = "PASEO_WINDOWS_JOB_LEADER_EXIT:test-proof:";
    const record = `${leaderExitMarker}4294967295\r\n`;

    for (let split = 1; split < record.length; split += 1) {
      const exitCodes: number[] = [];
      const parser = __windowsJobObjectInternals.createRecordParser(
        proofMarker,
        leaderExitMarker,
        () => undefined,
        (exitCode) => exitCodes.push(exitCode),
      );
      parser.write(record.slice(0, split));
      expect(exitCodes, `split ${split}`).toEqual([]);
      parser.write(record.slice(split));
      expect(exitCodes, `split ${split}`).toEqual([4_294_967_295]);
    }
  });

  test("requires a newline before resolving a split multi-digit leader exit", () => {
    const exitCodes: number[] = [];
    const leaderExitMarker = "PASEO_WINDOWS_JOB_LEADER_EXIT:test-proof:";
    const parser = __windowsJobObjectInternals.createRecordParser(
      "PASEO_WINDOWS_JOB_EMPTY:test-proof",
      leaderExitMarker,
      () => undefined,
      (exitCode) => exitCodes.push(exitCode),
    );

    parser.write(`${leaderExitMarker}2`);
    expect(exitCodes).toEqual([]);
    parser.write("3\r");
    expect(exitCodes).toEqual([]);
    parser.write("\n");
    expect(exitCodes).toEqual([23]);
  });

  test("rejects out-of-range leader exits and resumes scanning", () => {
    const exitCodes: number[] = [];
    const leaderExitMarker = "PASEO_WINDOWS_JOB_LEADER_EXIT:test-proof:";
    const parser = __windowsJobObjectInternals.createRecordParser(
      "PASEO_WINDOWS_JOB_EMPTY:test-proof",
      leaderExitMarker,
      () => undefined,
      (exitCode) => exitCodes.push(exitCode),
    );

    parser.write(`${leaderExitMarker}4294967296\n`);
    parser.write(`${leaderExitMarker}12345678901\n`);
    parser.write(`${leaderExitMarker}17\n`);

    expect(exitCodes).toEqual([17]);
  });

  test("retains bounded parser state across large descendant output", () => {
    const proofs: string[] = [];
    const exitCodes: number[] = [];
    const proofMarker = "PASEO_WINDOWS_JOB_EMPTY:test-proof";
    const leaderExitMarker = "PASEO_WINDOWS_JOB_LEADER_EXIT:test-proof:";
    const parser = __windowsJobObjectInternals.createRecordParser(
      proofMarker,
      leaderExitMarker,
      () => proofs.push("proved"),
      (exitCode) => exitCodes.push(exitCode),
    );

    parser.write("descendant output\n".repeat(100_000));
    expect(parser.getBufferedLength()).toBeLessThan(
      Math.max(proofMarker.length, leaderExitMarker.length),
    );
    parser.write(`${leaderExitMarker}23\n${"after exit\n".repeat(1_000)}`);
    parser.write(`${proofMarker}\n${"after proof\n".repeat(1_000)}`);

    expect(exitCodes).toEqual([23]);
    expect(proofs).toEqual(["proved"]);
    expect(parser.getBufferedLength()).toBeLessThan(
      Math.max(proofMarker.length, leaderExitMarker.length),
    );
  });

  test("observes complete records followed by more than the legacy 512-character tail", async () => {
    const child = createFakeChild();
    const spawn = createWindowsJobObjectProcessSpawner(() => child);
    const supervisor = spawn("C:\\opencode.exe", [], {
      envMode: "internal",
      env: {},
    });
    const proofMarker = getWindowsJobObjectProofMarker(supervisor)!;
    const leaderExitMarker = getWindowsJobObjectLeaderExitMarker(supervisor)!;

    child.stderr.write(
      `${leaderExitMarker}23\n${proofMarker}\n${"descendant output".repeat(1_000)}`,
    );
    await expect(getWindowsJobObjectLeaderExit(supervisor)).resolves.toBe(23);
    Object.defineProperty(child, "exitCode", { configurable: true, value: 23 });
    child.emit("close", 23, null);
    await expect(getWindowsJobObjectCompletion(supervisor)).resolves.toBe(true);
  });

  test("keeps process stdin byte-only and sends termination over the control channel", async () => {
    const child = createFakeChild();
    let requestCount = 0;
    const spawn = createWindowsJobObjectProcessSpawner(
      () => child,
      () => () => {
        requestCount += 1;
        return true;
      },
    );
    const supervisor = spawn("C:\\opencode.exe", [], {
      envMode: "internal",
      env: {},
    });
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const input = Buffer.from([0, 255, 13, 10, 10, 0, 195, 40]);

    child.stdin.write(input.subarray(0, 3));
    child.stdin.write(input.subarray(3));
    expect(createWindowsJobObjectTerminationTarget(supervisor).kill()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(chunks)).toEqual(input);
    expect(requestCount).toBe(1);
  });

  test("keeps the embedded bridge byte-streaming and free of PowerShell output pipelines", () => {
    expect(__windowsJobObjectInternals.supervisor).toContain("CopyToAsync(targetInput)");
    expect(__windowsJobObjectInternals.supervisor).not.toContain("ReadLineAsync");
    expect(__windowsJobObjectInternals.commandHost).toContain("Start-Process @options");
    expect(__windowsJobObjectInternals.commandHost).not.toContain("& $command");
  });

  test("compiles the embedded C# supervisor when PowerShell is available", () => {
    const match = __windowsJobObjectInternals.supervisor.match(/\$source = @'\n([\s\S]*?)\n'@/u);
    expect(match?.[1]).toBeDefined();
    const result = spawnSync(
      process.platform === "win32" ? "powershell.exe" : "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PASEO_TEST_CSHARP)); Add-Type -TypeDefinition $source",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PASEO_TEST_CSHARP: Buffer.from(match?.[1] ?? "", "utf8").toString("base64"),
        },
      },
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    expect(result.status, result.stderr).toBe(0);
  });

  test.runIf(process.platform === "win32")(
    "preserves binary stdio through a custom npm-style .cmd shim",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-windows-job-shim-"));
      tempDirs.push(directory);
      const command = join(directory, "custom-opencode.cmd");
      const target = join(directory, "echo-stdin.js");
      await writeFile(target, "process.stdin.pipe(process.stdout);\r\n", "utf8");
      await writeFile(
        command,
        `@echo off\r\n"${process.execPath}" "%~dp0echo-stdin.js"\r\n`,
        "utf8",
      );
      const spawn = createWindowsJobObjectProcessSpawner();
      const supervisor = spawn(command, [], {
        envMode: "internal",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      liveSupervisors.push(supervisor);
      const output = collectOutput(supervisor);
      const input = Buffer.from([0, 255, 13, 10, 10, 195, 40, 0]);

      await writeInChunks(supervisor, input, 3);
      await waitForExit(supervisor, 10_000);
      expect(supervisor.exitCode).toBe(0);
      await expect(output).resolves.toEqual(input);
    },
    30_000,
  );

  test.each(
    process.platform === "win32"
      ? [
          { extension: ".cmd", usePath: false },
          { extension: ".bat", usePath: false },
          { extension: ".cmd", usePath: true },
        ]
      : [],
  )(
    "preserves adversarial arguments through $extension (PATH lookup: $usePath)",
    async ({ extension, usePath }) => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-windows-job-args-"));
      tempDirs.push(directory);
      const commandName = "custom-opencode";
      const command = join(directory, `${commandName}${extension}`);
      const target = join(directory, "print-args.js");
      await writeFile(
        target,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\r\n",
        "utf8",
      );
      await writeFile(
        command,
        `@echo off\r\n"${process.execPath}" "%~dp0print-args.js" %*\r\n`,
        "utf8",
      );
      const targetArgs = [
        "two words",
        "x & whoami",
        "%PATH%",
        "(parentheses)",
        "pipe|redirect>file",
      ];
      const pathValue = `${directory}${delimiter}${process.env.PATH ?? ""}`;
      const spawn = createWindowsJobObjectProcessSpawner();
      const supervisor = spawn(usePath ? commandName : command, targetArgs, {
        envMode: "internal",
        env: { ...process.env, PATH: pathValue, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      liveSupervisors.push(supervisor);
      const output = collectOutput(supervisor);

      await waitForExit(supervisor, 10_000);
      expect(supervisor.exitCode).toBe(0);
      await expect(output).resolves.toEqual(Buffer.from(JSON.stringify(targetArgs)));
    },
    30_000,
  );

  test.each(process.platform === "win32" ? [process.execPath, "node"] : [])(
    "preserves binary stdin, partial writes, EOF, and backpressure for %s",
    async (command) => {
      const target = "process.stdin.pipe(process.stdout);";
      const spawn = createWindowsJobObjectProcessSpawner();
      const supervisor = spawn(command, ["-e", target], {
        envMode: "internal",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      liveSupervisors.push(supervisor);
      const output = collectOutput(supervisor);
      const input = Buffer.alloc(1024 * 1024 + 37);
      for (let index = 0; index < input.length; index += 1) {
        input[index] = index % 256;
      }

      await writeInChunks(supervisor, input, 7_919);
      await waitForExit(supervisor, 10_000);
      await expect(output).resolves.toEqual(input);
    },
    30_000,
  );

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
      expect(createWindowsJobObjectTerminationTarget(supervisor).kill()).toBe(true);
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

function decodeBase64(value: string | undefined): string {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}

function createOversizedEnvironmentBlock(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (let index = 0; index < 9; index += 1) {
    environment[`BLOCK_${index}`] = "x".repeat(8_000);
  }
  return environment;
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

function collectOutput(process: ChildProcess): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdout?.once("error", reject);
    process.stdout?.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function writeInChunks(
  process: ChildProcess,
  input: Buffer,
  chunkSize: number,
): Promise<void> {
  const stdin = process.stdin;
  if (!stdin) {
    throw new Error("Windows supervisor stdin is unavailable");
  }
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    if (!stdin.write(input.subarray(offset, offset + chunkSize))) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          stdin.off("drain", onDrain);
          stdin.off("error", onError);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        stdin.once("drain", onDrain);
        stdin.once("error", onError);
      });
    }
  }
  stdin.end();
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
