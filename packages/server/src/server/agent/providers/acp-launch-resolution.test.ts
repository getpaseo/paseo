import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ACPAgentClient, type SpawnedACPProcess } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../utils/spawn.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Creates a runnable stub for a command on PATH. On Windows the launcher is a
 * `.cmd` shim because `spawn` cannot execute an extensionless file directly.
 */
function createLauncherStub(binDir: string, name: string): string {
  const isWindows = process.platform === "win32";
  const fileName = isWindows ? `${name}.cmd` : name;
  const filePath = path.join(binDir, fileName);
  if (isWindows) {
    writeFileSync(filePath, "@echo off\r\nexit /b 0\r\n");
  } else {
    writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

// Windows PATH lookup returns the extension as PATHEXT spells it, so the
// resolved path can differ from the stub's own filename in case.
function expectSamePath(actual: string, expected: string): void {
  expect(actual.toLowerCase()).toBe(expected.toLowerCase());
}

function createChildStub(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdin = stdin as unknown as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout as unknown as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = stderr as unknown as ChildProcessWithoutNullStreams["stderr"];
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

class TestACPClient extends ACPAgentClient {
  async resolveLaunch(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }

  async spawnForTest(options?: { initializeTimeoutMs?: number }): Promise<SpawnedACPProcess> {
    return this.spawnProcess(undefined, options);
  }
}

/**
 * The generic client resolves its launcher the same way, and the resolution is
 * protected there too, so the test reaches it through a subclass rather than
 * through a cast.
 */
class TestGenericACPClient extends GenericACPAgentClient {
  async resolveLaunch(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ACP launch command resolution", () => {
  test("launch resolution prefers the absolute path over the bare command", async () => {
    const binDir = makeTempDir("acp-launch-path-");
    const launcher = createLauncherStub(binDir, "acp-path-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;

    try {
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-path-agent", "acp"],
      });

      const resolved = await client.resolveLaunch();
      expectSamePath(resolved.command, launcher);
      expect(resolved.args).toEqual(["acp"]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("generic ACP clients resolve the absolute path of their launcher", async () => {
    const binDir = makeTempDir("acp-launch-generic-");
    const launcher = createLauncherStub(binDir, "acp-generic-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;

    try {
      const client = new TestGenericACPClient({
        logger: createTestLogger(),
        command: ["acp-generic-agent", "acp"],
      });

      await expect(client.isAvailable()).resolves.toBe(true);

      const resolved = await client.resolveLaunch();
      expectSamePath(resolved.command, launcher);
      expect(resolved.args).toEqual(["acp"]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("launch resolution looks in the provider's own PATH, not the daemon's", async () => {
    const providerBinDir = makeTempDir("acp-launch-provider-path-");
    const daemonBinDir = makeTempDir("acp-launch-daemon-path-");
    const providerLauncher = createLauncherStub(providerBinDir, "acp-provider-agent");
    // The daemon's PATH holds a different build of the same command. The
    // provider's own PATH is what the child process will see, so it is what
    // the lookup has to use.
    const daemonLauncher = createLauncherStub(daemonBinDir, "acp-provider-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = daemonBinDir;

    try {
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-provider-agent", "acp"],
        runtimeSettings: { env: { PATH: providerBinDir } },
      });

      const resolved = await client.resolveLaunch();
      expectSamePath(resolved.command, providerLauncher);
      expect(resolved.command).not.toBe(daemonLauncher);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("generic ACP clients resolve against the provider's own PATH", async () => {
    // The probe and the session have to agree on the build they run. A
    // provider with its own PATH is probed against the daemon's PATH
    // otherwise, so the probe answers for a different build.
    const providerBinDir = makeTempDir("acp-launch-generic-provider-path-");
    const daemonBinDir = makeTempDir("acp-launch-generic-daemon-path-");
    const providerLauncher = createLauncherStub(providerBinDir, "acp-generic-path-agent");
    createLauncherStub(daemonBinDir, "acp-generic-path-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = daemonBinDir;

    try {
      const client = new TestGenericACPClient({
        logger: createTestLogger(),
        command: ["acp-generic-path-agent", "acp"],
        runtimeSettings: { env: { PATH: providerBinDir } },
      });

      const resolved = await client.resolveLaunch();
      expectSamePath(resolved.command, providerLauncher);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("launch resolution keeps the inherited PATH when the provider sets only a key", async () => {
    // A provider configured with just an API key carries no PATH of its own.
    // The child process inherits the daemon's PATH on top of that key, so the
    // lookup has to see the same environment the child will get.
    const binDir = makeTempDir("acp-launch-inherited-path-");
    const launcher = createLauncherStub(binDir, "acp-inherited-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;

    try {
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-inherited-agent", "acp"],
        runtimeSettings: { env: { API_KEY: "secret" } },
      });

      const resolved = await client.resolveLaunch();
      expectSamePath(resolved.command, launcher);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("launch resolution fails when no executable can be resolved", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = makeTempDir("acp-launch-empty-");

    try {
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-missing-agent", "acp"],
      });

      await expect(client.resolveLaunch()).rejects.toThrow("not found");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("ACP early child exit", () => {
  test("a session launches the resolved path, not the bare command", async () => {
    const binDir = makeTempDir("acp-launch-session-path-");
    const launcher = createLauncherStub(binDir, "acp-session-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;

    try {
      const child = createChildStub();
      const spawnProcess = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-session-agent", "acp"],
      });

      // The session starts for real, so the command that reaches the spawn is
      // the one a user would run.
      const sessionPromise = client.createSession({ provider: "acp", cwd: process.cwd() });
      await vi.waitFor(() => {
        expect(spawnProcess).toHaveBeenCalled();
      });

      const [command] = spawnProcess.mock.calls[0] ?? [];
      expectSamePath(String(command), launcher);

      child.emit("close", 1, null);
      await sessionPromise.catch(() => undefined);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("a session launches the path the provider's own PATH resolves to", async () => {
    // The session has to launch the path the lookup verified. A provider that
    // carries its own PATH resolves to an install the daemon's PATH does not
    // hold, and the session has to start that one.
    const providerBinDir = makeTempDir("acp-launch-session-provider-path-");
    const daemonBinDir = makeTempDir("acp-launch-session-daemon-path-");
    const providerLauncher = createLauncherStub(providerBinDir, "acp-session-path-agent");
    const originalPath = process.env.PATH;
    process.env.PATH = daemonBinDir;

    try {
      const child = createChildStub();
      const spawnProcess = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
      const client = new TestACPClient({
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["acp-session-path-agent", "acp"],
        runtimeSettings: { env: { PATH: providerBinDir } },
      });

      const sessionPromise = client.createSession({ provider: "acp", cwd: process.cwd() });
      await vi.waitFor(() => {
        expect(spawnProcess).toHaveBeenCalled();
      });

      const [command] = spawnProcess.mock.calls[0] ?? [];
      expectSamePath(String(command), providerLauncher);

      child.emit("close", 1, null);
      await sessionPromise.catch(() => undefined);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("rejects with the child's stderr instead of waiting for the initialize timeout", async () => {
    const child = createChildStub();
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);

    const client = new TestACPClient({
      provider: "acp",
      logger: createTestLogger(),
      // An absolute path resolves without a PATH lookup, so the spawn is
      // reached and the failure comes from the child, not from resolution.
      defaultCommand: [process.execPath, "acp"],
    });

    const initializePromise = client.spawnForTest({ initializeTimeoutMs: 120_000 });
    // The transport attaches its listeners after the (async) launch resolution
    // finishes, so wait for the spawn before simulating the child's failure.
    await vi.waitFor(() => {
      expect(child.listenerCount("close")).toBeGreaterThan(0);
    });
    // A broken launcher writes to stderr and exits before answering initialize.
    child.stderr.emit("data", "npm error could not determine executable to run\n");
    child.emit("close", 1, null);

    await expect(initializePromise).rejects.toThrow(
      /ACP agent process exited before initialization completed \(exit code 1\)/,
    );
    await expect(initializePromise).rejects.toThrow(
      /npm error could not determine executable to run/,
    );
  });
});
