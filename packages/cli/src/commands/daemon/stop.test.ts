import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";

// The daemon the gate is checked against: a connection whose server_info may or may not
// advertise terminalsSurviveRestart, and that records any shutdown it is asked for.
const daemon = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  shutdownRequests: [] as Array<{ keepTerminals?: boolean }>,
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: async () => ({
    getLastServerInfoMessage: () => ({ version: "0.11.0", features: daemon.features }),
    shutdownServer: async (options: { keepTerminals?: boolean }) => {
      daemon.shutdownRequests.push({ keepTerminals: options.keepTerminals });
      return { status: "shutdown_requested" };
    },
    close: async () => undefined,
  }),
}));

const { runStopCommand } = await import("./stop.js");

const cleanups: Array<() => void> = [];

afterEach(() => {
  daemon.features = {};
  daemon.shutdownRequests = [];
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function stop(options: Record<string, unknown>) {
  return runStopCommand(options as never, new Command("stop"));
}

// A home whose lock names a live stand-in supervisor, so the local stop path runs for real.
function homeWithRunningSupervisor(): { home: string; supervisor: ChildProcess } {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-stop-keep-"));
  const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  writeFileSync(
    path.join(home, "paseo.pid"),
    JSON.stringify({
      pid: supervisor.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:1",
    }),
  );
  cleanups.push(() => {
    supervisor.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  return { home, supervisor };
}

describe("daemon stop --keep-terminals", () => {
  test("refuses an endpoint daemon that does not advertise terminalsSurviveRestart", async () => {
    await expect(
      stop({ daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true }),
    ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
    expect(daemon.shutdownRequests).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a local daemon without the capability and never signals its supervisor",
    async () => {
      const { home, supervisor } = homeWithRunningSupervisor();
      await expect(
        stop({ daemonTarget: { kind: "instance", home }, keepTerminals: true }),
      ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
      expect(daemon.shutdownRequests).toEqual([]);
      expect(supervisor.exitCode).toBeNull();
      expect(supervisor.signalCode).toBeNull();
    },
  );

  test("asks a capable daemon to keep its terminals", async () => {
    daemon.features = { terminalsSurviveRestart: true };
    await stop({ daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true });
    expect(daemon.shutdownRequests).toEqual([{ keepTerminals: true }]);
  });

  test("rejects --force with --keep-terminals before contacting the daemon", async () => {
    const { home } = homeWithRunningSupervisor();
    await expect(
      stop({ daemonTarget: { kind: "instance", home }, keepTerminals: true, force: true }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(daemon.shutdownRequests).toEqual([]);
  });
});
