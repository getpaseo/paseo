import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ServiceManagedDaemonError, stopLocalDaemon } from "./local-daemon.js";

const DAEMON_PID = 424_242;

const treeKillCalls: string[] = [];
let daemonStopped = false;

vi.mock("tree-kill", () => ({
  default: (pid: number, signal: string, callback: (error?: Error) => void) => {
    treeKillCalls.push(`${pid}:${signal}`);
    daemonStopped = true;
    callback();
  },
}));

const tempRoots: string[] = [];

beforeEach(() => {
  treeKillCalls.length = 0;
  daemonStopped = false;
  // Liveness probes only. Real signals go through the mocked tree-kill above, so
  // this suite never touches a process on the machine running it.
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0 && signal !== undefined) {
      treeKillCalls.push(`${_pid}:${String(signal)}`);
      daemonStopped = true;
      return true;
    }
    if (daemonStopped) {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }
    return true;
  });
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

/**
 * `listen` points at a closed port so the lifecycle RPC cannot succeed. That is
 * the dangerous shape: before the fence, an unreachable daemon fell straight
 * through to signalling the owner process, which under launchd/systemd is the
 * supervisor the service manager is responsible for.
 */
async function createPaseoHomeWithPidLock(lock: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-service-managed-"));
  tempRoots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({
      pid: DAEMON_PID,
      startedAt: new Date(0).toISOString(),
      hostname: "test-host",
      uid: 0,
      listen: "127.0.0.1:1",
      ...lock,
    }),
  );
  return paseoHome;
}

test("refuses to stop a service-managed daemon and never signals the owner process", async () => {
  const paseoHome = await createPaseoHomeWithPidLock({ serviceManaged: true });

  await expect(stopLocalDaemon({ home: paseoHome, timeoutMs: 2_000 })).rejects.toBeInstanceOf(
    ServiceManagedDaemonError,
  );

  expect(treeKillCalls).toEqual([]);
});

test("--force does not authorize stopping a service-managed daemon", async () => {
  const paseoHome = await createPaseoHomeWithPidLock({ serviceManaged: true });

  await expect(
    stopLocalDaemon({ home: paseoHome, timeoutMs: 2_000, force: true }),
  ).rejects.toBeInstanceOf(ServiceManagedDaemonError);

  expect(treeKillCalls).toEqual([]);
});

test("an explicit service maintenance stop is allowed through", async () => {
  const paseoHome = await createPaseoHomeWithPidLock({ serviceManaged: true });

  const result = await stopLocalDaemon({
    home: paseoHome,
    timeoutMs: 2_000,
    serviceMaintenance: true,
  });

  expect(result.action).toBe("stopped");
  expect(treeKillCalls).toEqual([`${DAEMON_PID}:SIGTERM`]);
});

test("an unmanaged daemon keeps its existing stop semantics", async () => {
  const paseoHome = await createPaseoHomeWithPidLock({});

  const result = await stopLocalDaemon({ home: paseoHome, timeoutMs: 2_000 });

  expect(result.action).toBe("stopped");
  expect(treeKillCalls).toEqual([`${DAEMON_PID}:SIGTERM`]);
});

test("a desktop-managed daemon keeps its existing stop semantics", async () => {
  const paseoHome = await createPaseoHomeWithPidLock({ desktopManaged: true });

  const result = await stopLocalDaemon({ home: paseoHome, timeoutMs: 2_000 });

  expect(result.action).toBe("stopped");
  expect(treeKillCalls).toEqual([`${DAEMON_PID}:SIGTERM`]);
});
