import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  MANAGED_PROCESS_IDENTITY_ENV,
} from "./managed-processes.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe.runIf(process.platform !== "win32")("managed POSIX process-group scope", () => {
  test("does not claim a descendant that leaves the recorded group with setsid", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-posix-"));
    const identityToken = `setsid-scope-${process.pid}`;
    const ownerScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      process.send(child.pid);
      setInterval(() => {}, 1000);
    `;
    const owner = spawn(process.execPath, ["-e", ownerScript], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, [MANAGED_PROCESS_IDENTITY_ENV]: identityToken },
    });
    const ownerPid = owner.pid;
    if (!ownerPid) {
      throw new Error("Failed to spawn the managed process-group owner");
    }
    let escapedPid: number | null = null;

    try {
      const [message] = await Promise.race([
        once(owner, "message"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for the setsid descendant")), 5_000),
        ),
      ]);
      if (typeof message !== "number") {
        throw new Error("Managed process-group fixture returned an invalid descendant PID");
      }
      escapedPid = message;
      const registry = createManagedProcessRegistry({
        paseoHome: tempHome,
        processTable: createSystemManagedProcessTable(),
        terminateProcess: terminateWithTreeKill,
        logger: createTestLogger(),
      });
      await registry.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid: ownerPid,
        command: process.execPath,
        args: ["-e", ownerScript],
        lifecycle: { execTransition: "none", terminationScope: "process-group" },
        identityToken,
      });

      const result = await registry.reapStale();

      expect(result).toMatchObject({ checked: 1, removed: 1, terminated: 1, errors: [] });
      expect(isProcessAlive(escapedPid)).toBe(true);
      expect(await registry.list()).toEqual([]);
    } finally {
      safeKill(-ownerPid);
      if (escapedPid !== null) {
        safeKill(escapedPid);
      }
    }
  }, 15_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The cleanup target can exit before the test's finalizer runs.
  }
}
