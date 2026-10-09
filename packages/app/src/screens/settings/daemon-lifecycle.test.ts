import { expect, test } from "vitest";
import { restartDaemonFromSettings, updateDaemonFromSettings } from "./daemon-lifecycle";

test("settings restart completes when a replacement worker is observed without a sampled disconnect", async () => {
  let pid = 10;
  await restartDaemonFromSettings("daemon", "settings", {
    getStatus: async () => ({ pid, version: "1.0.0", serverId: "daemon" }),
    restartServer: async () => {
      pid = 11;
    },
  });
  expect(pid).toBe(11);
});

test("a status permission failure prevents the restart request", async () => {
  let restarted = false;
  await expect(
    restartDaemonFromSettings("daemon", "settings", {
      getStatus: async () => {
        throw new Error("Permission denied");
      },
      restartServer: async () => {
        restarted = true;
      },
    }),
  ).rejects.toThrow("Permission denied");
  expect(restarted).toBe(false);
});

test("a different responder fails confirmation immediately", async () => {
  let serverId = "daemon";
  await expect(
    restartDaemonFromSettings("daemon", "settings", {
      getStatus: async () => ({ pid: 10, version: "1.0.0", serverId }),
      restartServer: async () => {
        serverId = "other";
      },
    }),
  ).rejects.toThrow("identity changed");
});

test("a lost restart acknowledgment can still confirm the replacement", async () => {
  let pid = 10;
  await restartDaemonFromSettings("daemon", "settings", {
    getStatus: async () => ({ pid, version: "1.0.0", serverId: "daemon" }),
    restartServer: async () => {
      pid = 11;
      throw Object.assign(new Error("Connection lost"), { code: "DAEMON_CONNECTION_LOST" });
    },
  });
  expect(pid).toBe(11);
});

test("installation and worker version confirmation are separate outcomes", async () => {
  let pid = 10;
  await expect(
    updateDaemonFromSettings("daemon", {
      getStatus: async () => ({ pid, version: "1.0.0", serverId: "daemon" }),
      updateDaemon: async () => {
        pid = 11;
        return { success: true, error: null, newVersion: "2.0.0" };
      },
    }),
  ).rejects.toThrow("Package installed; replacement worker version was not confirmed");
});

test("an installed version is confirmed only in its replacement worker", async () => {
  let pid = 10,
    version = "1.0.0";
  await expect(
    updateDaemonFromSettings("daemon", {
      getStatus: async () => ({ pid, version, serverId: "daemon" }),
      updateDaemon: async () => {
        pid = 11;
        version = "2.0.0";
        return { success: true, error: null, newVersion: version };
      },
    }),
  ).resolves.toEqual({ workerVersion: "2.0.0" });
});

test("RPC errors mentioning transport are not retried", async () => {
  let requested = false;
  await expect(
    restartDaemonFromSettings("daemon", "settings", {
      getStatus: async () => {
        if (requested)
          throw Object.assign(new Error("Connection policy denied by plugin"), {
            code: "permission_denied",
          });
        return { pid: 10, version: "1.0.0", serverId: "daemon" };
      },
      restartServer: async () => {
        requested = true;
      },
    }),
  ).rejects.toThrow("Connection policy denied by plugin");
});
