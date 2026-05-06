import { describe, expect, it } from "vitest";
import { executeDaemonManagementToggle } from "./daemon-management-toggle";
import type { DesktopDaemonStatus } from "./desktop-daemon";

const runningManagedStatus: DesktopDaemonStatus = {
  serverId: "desktop",
  status: "running",
  listen: null,
  hostname: null,
  pid: 123,
  home: "/tmp/paseo",
  version: "1.0.0",
  desktopManaged: true,
  error: null,
};

const stoppedStatus: DesktopDaemonStatus = { ...runningManagedStatus, status: "stopped" };

function makeDeps(overrides?: {
  confirm?: () => Promise<boolean>;
  persistSettings?: (next: { manageBuiltInDaemon: boolean }) => Promise<void>;
  startDaemon?: () => Promise<DesktopDaemonStatus>;
  stopDaemon?: () => Promise<DesktopDaemonStatus>;
}) {
  const calls: string[] = [];
  return {
    deps: {
      confirm: overrides?.confirm ?? (() => Promise.resolve(true)),
      persistSettings:
        overrides?.persistSettings ??
        (async () => {
          calls.push("persist");
        }),
      startDaemon:
        overrides?.startDaemon ??
        (async () => {
          calls.push("start");
          return { ...runningManagedStatus, status: "running" as const };
        }),
      stopDaemon:
        overrides?.stopDaemon ??
        (async () => {
          calls.push("stop");
          return stoppedStatus;
        }),
    },
    calls,
  };
}

describe("executeDaemonManagementToggle", () => {
  describe("enable path (currentlyManaging: false)", () => {
    it("persists the new setting then starts the daemon", async () => {
      const { deps, calls } = makeDeps();

      const result = await executeDaemonManagementToggle(false, null, deps);

      expect(result).toEqual({ kind: "enabled", newStatus: runningManagedStatus });
      expect(calls).toEqual(["persist", "start"]);
    });

    it("persists manageBuiltInDaemon: true", async () => {
      let persisted: { manageBuiltInDaemon: boolean } | null = null;
      const { deps } = makeDeps({
        persistSettings: async (next) => {
          persisted = next;
        },
      });

      await executeDaemonManagementToggle(false, null, deps);

      expect(persisted).toEqual({ manageBuiltInDaemon: true });
    });
  });

  describe("disable path (currentlyManaging: true)", () => {
    it("returns cancelled without changing settings when confirmation is rejected", async () => {
      const persistedSettings: unknown[] = [];
      const { deps } = makeDeps({
        confirm: () => Promise.resolve(false),
        persistSettings: async (next) => {
          persistedSettings.push(next);
        },
      });

      const result = await executeDaemonManagementToggle(true, runningManagedStatus, deps);

      expect(result).toEqual({ kind: "cancelled" });
      expect(persistedSettings).toHaveLength(0);
    });

    it("persists settings BEFORE stopping the daemon", async () => {
      const callOrder: string[] = [];
      const { deps } = makeDeps({
        persistSettings: async () => {
          callOrder.push("persist");
        },
        stopDaemon: async () => {
          callOrder.push("stop");
          return stoppedStatus;
        },
      });

      await executeDaemonManagementToggle(true, runningManagedStatus, deps);

      expect(callOrder).toEqual(["persist", "stop"]);
    });

    it("persists manageBuiltInDaemon: false when disabling", async () => {
      let persisted: { manageBuiltInDaemon: boolean } | null = null;
      const { deps } = makeDeps({
        persistSettings: async (next) => {
          persisted = next;
        },
      });

      await executeDaemonManagementToggle(true, runningManagedStatus, deps);

      expect(persisted).toEqual({ manageBuiltInDaemon: false });
    });

    it("stops the daemon when it is running and desktop-managed", async () => {
      const { deps, calls } = makeDeps();

      const result = await executeDaemonManagementToggle(true, runningManagedStatus, deps);

      expect(calls).toContain("stop");
      expect(result).toEqual({ kind: "disabled", newStatus: stoppedStatus });
    });

    it("skips stop when daemon is running but not desktop-managed", async () => {
      const { deps, calls } = makeDeps();
      const manuallyManagedStatus = { ...runningManagedStatus, desktopManaged: false };

      const result = await executeDaemonManagementToggle(true, manuallyManagedStatus, deps);

      expect(calls).not.toContain("stop");
      expect(result).toEqual({ kind: "disabled", newStatus: null });
    });

    it("skips stop when daemon is stopped (regardless of desktopManaged)", async () => {
      const { deps, calls } = makeDeps();

      const result = await executeDaemonManagementToggle(true, stoppedStatus, deps);

      expect(calls).not.toContain("stop");
      expect(result).toEqual({ kind: "disabled", newStatus: null });
    });

    it("skips stop when daemonStatus is null", async () => {
      const { deps, calls } = makeDeps();

      const result = await executeDaemonManagementToggle(true, null, deps);

      expect(calls).not.toContain("stop");
      expect(result).toEqual({ kind: "disabled", newStatus: null });
    });
  });
});
