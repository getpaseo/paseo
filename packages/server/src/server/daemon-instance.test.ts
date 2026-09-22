import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { stopDaemonInstance } from "./daemon-instance.js";

describe("stopDaemonInstance requireLifecycleRpc", () => {
  const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    vi.restoreAllMocks();
  });

  test("a refused lifecycle RPC does not fall through to SIGTERM", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-idle-stop-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    const pid = child.pid;
    if (!pid) throw new Error("sleep child has no pid");
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const original = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((
      target: number,
      signal?: NodeJS.Signals | number,
    ) => {
      signals.push(signal);
      if (signal === "SIGTERM" || signal === "SIGKILL") return true;
      return original(target, signal);
    }) as typeof process.kill);

    try {
      await writeFile(
        join(home, "paseo.pid"),
        JSON.stringify({
          pid,
          startedAt: "2026-09-22T00:00:00.000Z",
          hostname: "test",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:9",
        }),
      );

      await expect(
        stopDaemonInstance(home, {
          requireLifecycleRpc: true,
          timeoutMs: 1_000,
          requestShutdown: async () => {
            throw Object.assign(new Error("Agents are busy"), { code: "AGENTS_BUSY" });
          },
        }),
      ).rejects.toThrow(/Agents are busy/);

      expect(signals).not.toContain("SIGTERM");
      expect(signals).not.toContain("SIGKILL");
      expect(original(pid, 0)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
