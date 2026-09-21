import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readDaemonInstance, stopDaemonInstance } from "./daemon-instance.js";
import { getPidLockInfo } from "./pid-lock.js";

describe("daemon-instance foreign-host lock", () => {
  test("status and stop ignore a foreign-hostname lock on a live local PID", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-foreign-"));
    try {
      // A lock written on another pod/host naming a PID that is alive here
      // (PID reuse across redeploys). Status must not report it as the
      // daemon and stop must not signal the unrelated local process.
      await writeFile(
        join(home, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "dead-pod-foreign-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          heartbeat: true,
        }),
      );

      await expect(readDaemonInstance(home)).resolves.toBeNull();

      const result = await stopDaemonInstance(home);
      expect(result.action).toBe("not_running");

      await expect(getPidLockInfo(home)).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
