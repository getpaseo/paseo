import { describe, expect, it, vi } from "vitest";
import { DaemonStartService, upsertDesktopDaemonConnection } from "./daemon-start-service";
import type { HostRuntimeStore } from "./host-runtime";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

interface RecordedUpsert {
  listenAddress: string;
  serverId: string;
  hostname: string | null;
}

function createFakeStore(): {
  store: Pick<HostRuntimeStore, "upsertConnectionFromListen">;
  upserts: RecordedUpsert[];
} {
  const upserts: RecordedUpsert[] = [];
  const store = {
    upsertConnectionFromListen: async (input: RecordedUpsert) => {
      upserts.push(input);
      return {} as Awaited<ReturnType<HostRuntimeStore["upsertConnectionFromListen"]>>;
    },
  };
  return { store, upserts };
}

function makeStatus(overrides: Partial<DesktopDaemonStatus> = {}): DesktopDaemonStatus {
  return {
    serverId: "srv_desktop",
    status: "running",
    listen: "127.0.0.1:6767",
    hostname: "desktop",
    pid: 1234,
    home: "/home",
    version: "0.0.0",
    desktopManaged: true,
    error: null,
    ...overrides,
  };
}

describe("DaemonStartService", () => {
  it("upserts the connection on a successful daemon start", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus(),
    });

    const result = await service.start();

    expect(result).toEqual({ ok: true });
    expect(fake.upserts).toEqual([
      { listenAddress: "127.0.0.1:6767", serverId: "srv_desktop", hostname: "desktop" },
    ]);
    expect(service.getLastError()).toBeNull();
    expect(service.isRunning()).toBe(false);
  });

  it("reports lastError after a missing listen address and clears running state when done", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus({ listen: null }),
    });

    const result = await service.start();

    expect(result).toEqual({
      ok: false,
      error: "Desktop daemon did not return a listen address.",
    });
    expect(service.getLastError()).toBe("Desktop daemon did not return a listen address.");
    expect(service.isRunning()).toBe(false);
    expect(fake.upserts).toEqual([]);
  });

  it("reports lastError when the daemon does not return a server id", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus({ serverId: "" }),
    });

    const result = await service.start();

    expect(result).toEqual({ ok: false, error: "Desktop daemon did not return a server id." });
    expect(service.getLastError()).toBe("Desktop daemon did not return a server id.");
    expect(fake.upserts).toEqual([]);
  });

  it("reports lastError when the listen address is unsupported", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus({ listen: "???" }),
    });

    const result = await service.start();

    expect(result.ok).toBe(false);
    expect(service.getLastError()).toContain("unsupported listen address");
    expect(fake.upserts).toEqual([]);
  });

  it("reports lastError when the underlying start call throws", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => {
        throw new Error("ipc broke");
      },
    });

    const result = await service.start();

    expect(result).toEqual({ ok: false, error: "ipc broke" });
    expect(service.getLastError()).toBe("ipc broke");
  });

  it("clears lastError on retry entry and reports null after subsequent success", async () => {
    const fake = createFakeStore();
    const startMock = vi
      .fn<() => Promise<DesktopDaemonStatus>>()
      .mockRejectedValueOnce(new Error("ipc broke"))
      .mockResolvedValueOnce(makeStatus());
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: () => startMock(),
    });

    const failure = await service.start();
    expect(failure.ok).toBe(false);
    expect(service.getLastError()).toBe("ipc broke");

    const success = await service.start();
    expect(success).toEqual({ ok: true });
    expect(service.getLastError()).toBeNull();
  });

  it("notifies subscribers when isRunning toggles between calls", async () => {
    const fake = createFakeStore();
    let resolveStart: ((value: DesktopDaemonStatus) => void) | undefined;
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: () =>
        new Promise<DesktopDaemonStatus>((resolve) => {
          resolveStart = resolve;
        }),
    });

    const runningSnapshots: boolean[] = [];
    service.subscribe(() => {
      runningSnapshots.push(service.isRunning());
    });

    const startPromise = service.start();
    expect(service.isRunning()).toBe(true);
    expect(runningSnapshots).toEqual([true]);

    resolveStart?.(makeStatus());
    await startPromise;

    expect(service.isRunning()).toBe(false);
    expect(runningSnapshots).toEqual([true, false]);
  });

  it("stays running while deciding whether the managed daemon should start", async () => {
    const fake = createFakeStore();
    let resolveCondition: ((value: boolean) => void) | undefined;
    let daemonStartCount = 0;
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => {
        daemonStartCount += 1;
        return makeStatus();
      },
    });

    const startPromise = service.startIfEnabled({
      shouldStart: () =>
        new Promise<boolean>((resolve) => {
          resolveCondition = resolve;
        }),
    });

    expect(service.isRunning()).toBe(true);
    expect(daemonStartCount).toBe(0);

    resolveCondition?.(true);
    await startPromise;

    expect(service.isRunning()).toBe(false);
    expect(daemonStartCount).toBe(1);
  });

  it("finishes without starting the daemon when management is disabled", async () => {
    const fake = createFakeStore();
    let daemonStartCount = 0;
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => {
        daemonStartCount += 1;
        return makeStatus();
      },
    });

    const result = await service.startIfEnabled({ shouldStart: false });

    expect(result).toEqual({ ok: true });
    expect(service.isRunning()).toBe(false);
    expect(daemonStartCount).toBe(0);
  });

  it("clears the error and notifies subscribers when retry begins", async () => {
    const fake = createFakeStore();
    const startMock = vi
      .fn<() => Promise<DesktopDaemonStatus>>()
      .mockRejectedValueOnce(new Error("ipc broke"))
      .mockResolvedValueOnce(makeStatus());
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: () => startMock(),
    });

    await service.start();
    expect(service.getLastError()).toBe("ipc broke");

    const errorSnapshots: Array<string | null> = [];
    service.subscribe(() => {
      errorSnapshots.push(service.getLastError());
    });

    await service.start();
    expect(errorSnapshots[0]).toBeNull();
    expect(service.getLastError()).toBeNull();
  });

  it("surfaces settings errors through the daemon startup state", async () => {
    const fake = createFakeStore();
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus(),
    });

    const result = await service.startIfEnabled({
      shouldStart: async () => {
        throw new Error("settings file unreadable");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Failed to evaluate desktop daemon settings: settings file unreadable",
    });
    expect(service.getLastError()).toBe(
      "Failed to evaluate desktop daemon settings: settings file unreadable",
    );
    expect(service.isRunning()).toBe(false);
  });

  it("stops notifying after a subscriber unsubscribes", async () => {
    const fake = createFakeStore();
    let notifications = 0;
    const service = new DaemonStartService({
      store: fake.store,
      startDesktopDaemon: async () => makeStatus({ listen: null }),
    });
    const unsubscribe = service.subscribe(() => {
      notifications += 1;
    });

    await service.start();
    const countAfterFirst = notifications;
    expect(countAfterFirst).toBeGreaterThan(0);

    unsubscribe();
    await service.start();
    expect(notifications).toBe(countAfterFirst);
  });
});

describe("upsertDesktopDaemonConnection", () => {
  it("upserts a valid desktop daemon status", async () => {
    const fake = createFakeStore();

    const result = await upsertDesktopDaemonConnection(fake.store, makeStatus());

    expect(result).toEqual({ ok: true });
    expect(fake.upserts).toEqual([
      { listenAddress: "127.0.0.1:6767", serverId: "srv_desktop", hostname: "desktop" },
    ]);
  });

  it("rejects a missing listen address without upserting", async () => {
    const fake = createFakeStore();

    const result = await upsertDesktopDaemonConnection(fake.store, makeStatus({ listen: null }));

    expect(result).toEqual({
      ok: false,
      error: "Desktop daemon did not return a listen address.",
    });
    expect(fake.upserts).toEqual([]);
  });

  it("rejects a missing server id without upserting", async () => {
    const fake = createFakeStore();

    const result = await upsertDesktopDaemonConnection(fake.store, makeStatus({ serverId: "" }));

    expect(result).toEqual({
      ok: false,
      error: "Desktop daemon did not return a server id.",
    });
    expect(fake.upserts).toEqual([]);
  });

  it("rejects an unsupported listen address without upserting", async () => {
    const fake = createFakeStore();

    const result = await upsertDesktopDaemonConnection(fake.store, makeStatus({ listen: "???" }));

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("unsupported listen address");
    expect(fake.upserts).toEqual([]);
  });
});
