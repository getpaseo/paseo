import { describe, expect, it } from "vitest";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { restartDaemonFromSettings, type SettingsDaemonRestartDeps } from "./daemon-restart";

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
