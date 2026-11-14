import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { probe } from "./process.js";

const temporary: string[] = [];

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child may still be starting.
    }
    await delay(10);
  }
  throw new Error("Timed-out child did not write its PID");
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("times out a slow discovery process with PROBE_TIMEOUT", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-probe-"));
  temporary.push(root);
  const script = path.join(root, "slow-agy.mjs");
  const pidFile = path.join(root, "pid");
  await writeFile(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.argv[2], String(process.pid));",
      "setTimeout(() => {}, 5000);",
    ].join("\n"),
  );

  const result = probe({
    launch: { command: process.execPath, args: [script], env: {} },
    args: [pidFile],
    timeoutMs: 3_000,
  });

  const childPid = await waitForPidFile(pidFile);

  await expect(result).rejects.toMatchObject({ code: "PROBE_TIMEOUT" });
  expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

it("returns discovery output when the process exits successfully", async () => {
  await expect(
    probe({
      launch: {
        command: process.execPath,
        args: ["-e", 'process.stdout.write("agy discovery output")'],
        env: {},
      },
      args: [],
    }),
  ).resolves.toBe("agy discovery output");
});
