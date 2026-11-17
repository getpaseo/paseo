import { describe, expect, it } from "vitest";
import type { DesktopDaemonStatus } from "./daemon-manager";
import { createDesktopDaemonUpdateLifecycle } from "./update-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const status: DesktopDaemonStatus = {
  serverId: "test",
  status: "running",
  listen: "127.0.0.1:6799",
  hostname: "host",
  pid: 123,
  home: "/home/paseo",
  version: "1.0.0",
  desktopManaged: true,
  ownedByDesktop: true,
  startedAt: "2026-11-17T00:00:00.000Z",
  error: null,
};

describe("daemon update lifecycle", () => {
  it("coalesces starts and waits for the in-flight launch before stopping for update", async () => {
    const launch = deferred<DesktopDaemonStatus>();
    const calls: string[] = [];
    const lifecycle = createDesktopDaemonUpdateLifecycle({
      start: () => {
        calls.push("start");
        return launch.promise;
      },
      stopForUpdate: async () => {
        calls.push("stop");
      },
    });

    const first = lifecycle.start();
    const second = lifecycle.start();
    expect(second).toBe(first);
    const installation = lifecycle.install(async (prepare) => {
      await prepare();
      calls.push("install");
      return true;
    });
    expect(calls).toEqual(["start"]);
    await expect(lifecycle.start()).rejects.toThrow("installing an app update");
    launch.resolve(status);
    await expect(first).resolves.toEqual(status);
    await expect(installation).resolves.toBe(true);
    expect(calls).toEqual(["start", "stop", "install"]);
    await expect(lifecycle.start()).rejects.toThrow("installing an app update");
  });

  it.each([false, { installed: false, version: null, message: "Deferred" }])(
    "allows a retry after a deferred installation %j",
    async (result) => {
      const lifecycle = createDesktopDaemonUpdateLifecycle({
        start: async () => status,
        stopForUpdate: async () => undefined,
      });

      expect(
        await lifecycle.install(async (prepare) => {
          await prepare();
          return result;
        }),
      ).toEqual(result);
      await expect(lifecycle.start()).resolves.toEqual(status);
    },
  );

  it("allows starts after shutdown fails and does not invoke the installer", async () => {
    const lifecycle = createDesktopDaemonUpdateLifecycle({
      start: async () => status,
      stopForUpdate: async () => {
        throw new Error("Shutdown failed");
      },
    });
    let installed = false;

    await expect(
      lifecycle.install(async (prepare) => {
        await prepare();
        installed = true;
        return true;
      }),
    ).rejects.toThrow("Shutdown failed");
    expect(installed).toBe(false);
    await expect(lifecycle.start()).resolves.toEqual(status);
  });

  it("does not let a competing install release the successful install's start gate", async () => {
    const stopping = deferred<void>();
    const lifecycle = createDesktopDaemonUpdateLifecycle({
      start: async () => status,
      stopForUpdate: () => stopping.promise,
    });
    const first = lifecycle.install(async (prepare) => {
      await prepare();
      return true;
    });

    await expect(
      lifecycle.install(async (prepare) => {
        await prepare();
        return true;
      }),
    ).rejects.toThrow("already installing");
    await expect(lifecycle.start()).rejects.toThrow("installing an app update");
    stopping.resolve();
    await expect(first).resolves.toBe(true);
    await expect(lifecycle.start()).rejects.toThrow("installing an app update");
  });

  it("does not install if the pending daemon launch fails", async () => {
    const launch = deferred<DesktopDaemonStatus>();
    let starts = 0;
    let stops = 0;
    const lifecycle = createDesktopDaemonUpdateLifecycle({
      start: async () => {
        starts += 1;
        if (starts === 1) return launch.promise;
        return status;
      },
      stopForUpdate: async () => {
        stops += 1;
      },
    });
    const pendingStart = lifecycle.start();
    const installation = lifecycle.install(async (prepare) => {
      await prepare();
      return true;
    });
    launch.reject(new Error("Launch failed"));

    await expect(pendingStart).rejects.toThrow("Launch failed");
    await expect(installation).rejects.toThrow("Launch failed");
    expect(stops).toBe(0);
    await expect(lifecycle.start()).resolves.toEqual(status);
  });
});
