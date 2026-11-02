import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

// Linux delivers the existing inventory as one batch. Other backends have
// different startup semantics, so they do not exercise this regression.
test.skipIf(process.platform !== "linux").each(["healthy", "directory-churn"])(
  "%s benchmark collects a startup batch larger than the argument limit",
  async (mode) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "paseo-watch-benchmark-test-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          // Lower the argument limit instead of creating hundreds of thousands
          // of files. This still runs the real observer and benchmark CLI.
          "--stack-size=256",
          "--import",
          "tsx",
          fileURLToPath(new URL("./measure-file-observer.ts", import.meta.url)),
          "--child",
        ],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            TMPDIR: temporaryRoot,
            PASEO_WATCH_BENCH_MODE: mode,
            PASEO_WATCH_BENCH_ROOTS: "1",
            PASEO_WATCH_BENCH_DIRS: "10",
            PASEO_WATCH_BENCH_PREEXISTING_FILES: "40000",
            PASEO_WATCH_BENCH_IGNORED_FILES: "1",
            PASEO_WATCH_BENCH_EDITS: "1",
            PASEO_WATCH_BENCH_SUSTAINED_EDITS: "1",
            PASEO_WATCH_BENCH_SUSTAINED_INTERVAL_MS: "1",
            PASEO_WATCH_BENCH_CHURN_DIRECTORIES: "10",
            PASEO_WATCH_BENCH_CHURN_FILES_PER_DIRECTORY: "4000",
            PASEO_WATCH_BENCH_CHURN_ROUNDS: "1",
            PASEO_WATCH_BENCH_CHURN_DIRECTORIES_PER_ROUND: "2",
          },
        },
      );
      const measurement = JSON.parse(stdout);
      expect(measurement.startupEvents).toBe(40_000);
      expect(measurement.deliveredEvents).toBeGreaterThan(measurement.startupEvents);
      expect(measurement.missedTrackedPaths).toBe(0);
      expect(measurement.ignoredEvents).toBe(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  90_000,
);
