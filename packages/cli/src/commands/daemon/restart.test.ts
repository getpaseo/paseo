import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { runRestartCommand, type DaemonRestartRuntime } from "./restart.js";
import type { DaemonStartOptions, LocalDaemonState } from "./local-daemon.js";

function createRuntime(listen = "127.0.0.1:6799") {
  const starts: DaemonStartOptions[] = [];
  const events: string[] = [];
  const state: LocalDaemonState = {
    home: "/test-home",
    listen,
    relayEnabled: false,
    relayEndpoint: "relay.paseo.sh:443",
    relayUseTls: true,
    relayPublicUseTls: true,
    logPath: "/test-home/daemon.log",
    pidPath: "/test-home/paseo.pid",
    pidInfo: { pid: 123, listen },
    running: true,
    stalePidFile: false,
  };
  const runtime: DaemonRestartRuntime = {
    resolveState: () => {
      events.push("resolve");
      return state;
    },
    stop: async () => {
      events.push("stop");
      // Stopping the supervisor removes the old listen metadata.
      state.listen = "127.0.0.1:6767";
      state.pidInfo = null;
      return {
        action: "stopped",
        home: "/test-home",
        pid: 123,
        forced: false,
        usedLifecycleRpc: true,
        reason: "lifecycle_shutdown_rpc",
        message: "stopped",
      };
    },
    start: async (options) => {
      events.push("start");
      starts.push(options);
      return { pid: 456, logPath: "/test-home/daemon.log" };
    },
  };
  return { runtime, starts, events, state };
}

describe("daemon restart target", () => {
  test.each(["127.0.0.1:6799", "[::1]:6799", "/test-home/daemon.sock"])(
    "preserves %s before stopping the old supervisor",
    async (previousListen) => {
      const { runtime, starts } = createRuntime(previousListen);
      await runRestartCommand({ home: "/test-home" }, new Command(), runtime);
      expect(starts.map(({ home, listen, port }) => ({ home, listen, port }))).toEqual([
        { home: "/test-home", listen: previousListen, port: undefined },
      ]);
    },
  );

  test("honors an explicit port override", async () => {
    const { runtime, starts } = createRuntime();
    await runRestartCommand({ home: "/test-home", port: "6800" }, new Command(), runtime);
    expect(starts.map(({ listen, port }) => ({ listen, port }))).toEqual([
      { listen: undefined, port: "6800" },
    ]);
  });

  test("honors an explicit listen override", async () => {
    const { runtime, starts } = createRuntime();
    await runRestartCommand(
      { home: "/test-home", listen: "127.0.0.1:6800" },
      new Command(),
      runtime,
    );
    expect(starts.map(({ listen, port }) => ({ listen, port }))).toEqual([
      { listen: "127.0.0.1:6800", port: undefined },
    ]);
  });

  test("does not start or retry with force when stop rejects a different daemon", async () => {
    const { runtime, starts, events } = createRuntime();
    runtime.stop = async () => {
      events.push("stop");
      throw new Error("Refusing to stop a different daemon");
    };
    await expect(runRestartCommand({ home: "/test-home" }, new Command(), runtime)).rejects.toEqual(
      {
        code: "RESTART_FAILED",
        message: "Failed to restart local daemon: Refusing to stop a different daemon",
      },
    );
    expect(events).toEqual(["resolve", "stop"]);
    expect(starts).toEqual([]);
  });
  test("leaves listen selection to startup when the daemon is stopped", async () => {
    const { runtime, starts, state } = createRuntime();
    state.running = false;
    state.pidInfo = null;
    await runRestartCommand({ home: "/test-home" }, new Command(), runtime);
    expect(starts.map(({ listen, port }) => ({ listen, port }))).toEqual([
      { listen: undefined, port: undefined },
    ]);
  });

  test("does not retain a stale supervisor's listen override", async () => {
    const { runtime, starts, state } = createRuntime();
    state.running = false;
    state.stalePidFile = true;
    await runRestartCommand({ home: "/test-home" }, new Command(), runtime);
    expect(starts.map(({ listen, port }) => ({ listen, port }))).toEqual([
      { listen: undefined, port: undefined },
    ]);
  });
});
