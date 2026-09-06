import { describe, expect, it } from "vitest";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import {
  restartDaemonAndWaitForReconnect,
  restartDaemonFromSettings,
  type SettingsDaemonRestartDeps,
} from "./daemon-restart";

const runningDesktopDaemonStatus: DesktopDaemonStatus = {
  serverId: "local-desktop",
  status: "running",
  listen: null,
  hostname: null,
  pid: 123,
  home: "/tmp/paseo",
  version: "1.0.0",
  desktopManaged: true,
  error: null,
};

const desktopSettings = {
  daemon: {
    manageBuiltInDaemon: true,
  },
};

function makeDeps(overrides?: {
  isElectron?: boolean;
  desktopDaemonStatus?: DesktopDaemonStatus;
  desktopSettings?: typeof desktopSettings;
  desktopSettingsError?: Error;
  restartDesktopDaemon?: () => Promise<DesktopDaemonStatus>;
  restartServer?: (reason: string) => Promise<void>;
}) {
  const calls: string[] = [];
  const deps: SettingsDaemonRestartDeps = {
    getIsElectron: () => overrides?.isElectron ?? true,
    getDesktopDaemonStatus: async () => {
      calls.push("desktop-status");
      return overrides?.desktopDaemonStatus ?? runningDesktopDaemonStatus;
    },
    getDesktopSettings: async () => {
      calls.push("desktop-settings");
      if (overrides?.desktopSettingsError) {
        throw overrides.desktopSettingsError;
      }
      return overrides?.desktopSettings ?? desktopSettings;
    },
    restartDesktopDaemon:
      overrides?.restartDesktopDaemon ??
      (async () => {
        calls.push("desktop-restart");
        return runningDesktopDaemonStatus;
      }),
    restartServer:
      overrides?.restartServer ??
      (async (reason) => {
        calls.push(`rpc-restart:${reason}`);
      }),
  };
  return { calls, deps };
}

describe("restartDaemonFromSettings", () => {
  it("restarts the local desktop-managed daemon through the desktop bridge", async () => {
    const { calls, deps } = makeDeps();

    await restartDaemonFromSettings(" local-desktop ", "settings_daemon_restart_local", deps);

    expect(calls).toEqual(["desktop-status", "desktop-settings", "desktop-restart"]);
  });

  it("restarts remote hosts over the daemon RPC without reading desktop settings", async () => {
    const { calls, deps } = makeDeps({
      desktopSettingsError: new Error("Unreadable desktop settings."),
    });

    await restartDaemonFromSettings("remote-host", "settings_daemon_restart_remote", deps);

    expect(calls).toEqual(["desktop-status", "rpc-restart:settings_daemon_restart_remote"]);
  });

  it("keeps manually managed local daemons on the RPC path without reading desktop settings", async () => {
    const { calls, deps } = makeDeps({
      desktopDaemonStatus: { ...runningDesktopDaemonStatus, desktopManaged: false },
      desktopSettingsError: new Error("Unreadable desktop settings."),
    });

    await restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps);

    expect(calls).toEqual(["desktop-status", "rpc-restart:settings_daemon_restart_local"]);
  });

  it("keeps the RPC path when built-in daemon management is disabled", async () => {
    const { calls, deps } = makeDeps({
      desktopSettings: {
        ...desktopSettings,
        daemon: { ...desktopSettings.daemon, manageBuiltInDaemon: false },
      },
    });

    await restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps);

    expect(calls).toEqual([
      "desktop-status",
      "desktop-settings",
      "rpc-restart:settings_daemon_restart_local",
    ]);
  });

  it("uses the RPC path outside Electron without reading desktop daemon status or settings", async () => {
    const { calls, deps } = makeDeps({
      isElectron: false,
    });

    await restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps);

    expect(calls).toEqual(["rpc-restart:settings_daemon_restart_local"]);
  });

  it("surfaces desktop restart failures without falling back to worker recycle", async () => {
    const { calls, deps } = makeDeps({
      restartDesktopDaemon: async () => {
        calls.push("desktop-restart");
        throw new Error("Desktop restart failed.");
      },
    });

    await expect(
      restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps),
    ).rejects.toThrow("Desktop restart failed.");

    expect(calls).toEqual(["desktop-status", "desktop-settings", "desktop-restart"]);
  });
});

describe("restartDaemonAndWaitForReconnect", () => {
  it("does not resolve when restart is only acknowledged", async () => {
    let snapshot: {
      connectionStatus: "online" | "offline";
      clientGeneration: number;
      lastOnlineAt: string | null;
    } = {
      connectionStatus: "online",
      clientGeneration: 3,
      lastOnlineAt: "2026-08-28T10:00:00.000Z",
    };
    const listeners = new Set<() => void>();
    let resolved = false;

    const operation = restartDaemonAndWaitForReconnect({
      restart: async () => undefined,
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeoutMs: 100,
    }).then(() => {
      resolved = true;
      return undefined;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    snapshot = { ...snapshot, connectionStatus: "offline" };
    for (const listener of listeners) listener();
    snapshot = {
      connectionStatus: "online",
      clientGeneration: 4,
      lastOnlineAt: "2026-08-28T10:00:01.000Z",
    };
    for (const listener of listeners) listener();

    await operation;
    expect(resolved).toBe(true);
  });

  it("rejects when the daemon never reconnects", async () => {
    const snapshot = {
      connectionStatus: "online" as const,
      clientGeneration: 3,
      lastOnlineAt: "2026-08-28T10:00:00.000Z",
    };

    await expect(
      restartDaemonAndWaitForReconnect({
        restart: async () => undefined,
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("Daemon did not reconnect after restart");
  });

  it("keeps waiting when the restart request rejects because the daemon disconnected", async () => {
    let snapshot = {
      connectionStatus: "online" as "online" | "offline",
      clientGeneration: 3,
      lastOnlineAt: "2026-08-28T10:00:00.000Z",
    };
    const listeners = new Set<() => void>();

    const operation = restartDaemonAndWaitForReconnect({
      restart: async () => {
        snapshot = { ...snapshot, connectionStatus: "offline" };
        for (const listener of listeners) listener();
        throw new Error("socket closed");
      },
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeoutMs: 100,
    });

    await Promise.resolve();
    snapshot = {
      connectionStatus: "online",
      clientGeneration: 4,
      lastOnlineAt: "2026-08-28T10:00:01.000Z",
    };
    for (const listener of listeners) listener();

    await expect(operation).resolves.toBeUndefined();
  });

  it("accepts a reconnect that completes before the restart request rejects", async () => {
    let snapshot = {
      connectionStatus: "online" as const,
      clientGeneration: 3,
      lastOnlineAt: "2026-08-28T10:00:00.000Z",
    };
    const listeners = new Set<() => void>();

    await expect(
      restartDaemonAndWaitForReconnect({
        restart: async () => {
          snapshot = {
            connectionStatus: "online",
            clientGeneration: 4,
            lastOnlineAt: "2026-08-28T10:00:01.000Z",
          };
          for (const listener of listeners) listener();
          throw new Error("old socket closed");
        },
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
  });
});
