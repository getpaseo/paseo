import { describe, expect, test } from "vitest";
import { requestLifecycleShutdown, type LifecycleShutdownRuntime } from "./lifecycle-shutdown.js";

function createRuntime(serverId: string | null = "srv_other") {
  const events: string[] = [];
  const runtime: LifecycleShutdownRuntime = {
    readServerId: () => "srv_test",
    connect: async () => {
      events.push("connect");
      return {
        getLastServerInfoMessage: () =>
          serverId === null
            ? null
            : {
                status: "server_info",
                serverId,
                version: "0.8.0-beta.1",
                hostname: "test-host",
              },
        shutdownServer: async () => {
          events.push("shutdown");
          return {
            status: "shutdown_requested",
            clientId: "test-client",
            requestId: "test-request",
          };
        },
        close: async () => {
          events.push("close");
        },
      };
    },
  };
  return { runtime, events };
}

describe("home-scoped lifecycle shutdown", () => {
  test("refuses to shut down a different daemon occupying the recorded port", async () => {
    const { runtime, events } = createRuntime();
    await expect(
      requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).rejects.toThrow("Refusing to stop");
    expect(events).toEqual(["connect", "close"]);
  });
  test("shuts down the matching daemon and closes the connection", async () => {
    const { runtime, events } = createRuntime("srv_test");
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6799", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({ requested: true });
    expect(events).toEqual(["connect", "shutdown", "close"]);
  });

  test("refuses an unidentified listener", async () => {
    const { runtime, events } = createRuntime(null);
    await expect(
      requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).rejects.toThrow("Refusing to stop");
    expect(events).toEqual(["connect", "close"]);
  });

  test("does not connect when the requested home has no identity", async () => {
    const { runtime, events } = createRuntime();
    runtime.readServerId = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({
      requested: false,
      reason: "daemon identity is missing in /test-home, falling back to owner PID signal",
    });
    expect(events).toEqual([]);
  });

  test("does not connect when the identity file is empty", async () => {
    const { runtime, events } = createRuntime();
    runtime.readServerId = () => "  ";
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({
      requested: false,
      reason: "daemon identity is missing in /test-home, falling back to owner PID signal",
    });
    expect(events).toEqual([]);
  });

  test("propagates identity read errors rather than sending shutdown", async () => {
    const { runtime, events } = createRuntime();
    runtime.readServerId = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    await expect(
      requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).rejects.toThrow("denied");
    expect(events).toEqual([]);
  });

  test("keeps the owner PID fallback when there is no reachable daemon", async () => {
    const { runtime, events } = createRuntime();
    runtime.connect = async () => null;
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: "127.0.0.1:6799", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({
      requested: false,
      reason:
        "daemon websocket at 127.0.0.1:6799 is not reachable, falling back to owner PID signal",
    });
    expect(events).toEqual([]);
  });

  test("keeps the owner PID fallback for a non-TCP listener", async () => {
    const { runtime, events } = createRuntime();
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: true, host: null, timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({
      requested: false,
      reason: "daemon listen target is not TCP, falling back to owner PID signal",
    });
    expect(events).toEqual([]);
  });
  test("leaves an unrelated listener alone when this home has no live owner", async () => {
    const { runtime, events } = createRuntime();
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: false, host: "127.0.0.1:6767", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({
      requested: false,
      reason: "daemon at 127.0.0.1:6767 belongs to another home; no live owner in /test-home",
    });
    expect(events).toEqual(["connect", "close"]);
  });

  test("still stops the matching daemon when its PID file is missing", async () => {
    const { runtime, events } = createRuntime("srv_test");
    expect(
      await requestLifecycleShutdown(
        { home: "/test-home", hasLiveOwner: false, host: "127.0.0.1:6799", timeoutMs: 5000 },
        runtime,
      ),
    ).toEqual({ requested: true });
    expect(events).toEqual(["connect", "shutdown", "close"]);
  });
});
