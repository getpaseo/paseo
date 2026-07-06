import { describe, expect, it } from "vitest";
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import {
  isLocalDesktopManagedDaemon,
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

function makeDeps(overrides?: {
  isElectron?: boolean;
  desktopDaemonStatus?: DesktopDaemonStatus;
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

describe("isLocalDesktopManagedDaemon", () => {
  it("matches only the Electron desktop-managed daemon with the same server id", () => {
    expect(isLocalDesktopManagedDaemon(" local-desktop ", runningDesktopDaemonStatus, true)).toBe(
      true,
    );
    expect(isLocalDesktopManagedDaemon("remote", runningDesktopDaemonStatus, true)).toBe(false);
    expect(isLocalDesktopManagedDaemon("local-desktop", runningDesktopDaemonStatus, false)).toBe(
      false,
    );
    expect(
      isLocalDesktopManagedDaemon(
        "local-desktop",
        { ...runningDesktopDaemonStatus, desktopManaged: false },
        true,
      ),
    ).toBe(false);
  });
});

describe("restartDaemonFromSettings", () => {
  it("restarts the local desktop-managed daemon through the desktop bridge", async () => {
    const { calls, deps } = makeDeps();

    await restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps);

    expect(calls).toEqual(["desktop-status", "desktop-restart"]);
  });

  it("restarts remote hosts over the daemon RPC", async () => {
    const { calls, deps } = makeDeps();

    await restartDaemonFromSettings("remote-host", "settings_daemon_restart_remote", deps);

    expect(calls).toEqual(["desktop-status", "rpc-restart:settings_daemon_restart_remote"]);
  });

  it("keeps manually managed local daemons on the RPC path", async () => {
    const { calls, deps } = makeDeps({
      desktopDaemonStatus: { ...runningDesktopDaemonStatus, desktopManaged: false },
    });

    await restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps);

    expect(calls).toEqual(["desktop-status", "rpc-restart:settings_daemon_restart_local"]);
  });

  it("uses the RPC path outside Electron without reading desktop daemon status", async () => {
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
        throw new Error("Built-in daemon management is disabled.");
      },
    });

    await expect(
      restartDaemonFromSettings("local-desktop", "settings_daemon_restart_local", deps),
    ).rejects.toThrow("Built-in daemon management is disabled.");

    expect(calls).toEqual(["desktop-status", "desktop-restart"]);
  });
});
