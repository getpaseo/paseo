import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { createFileObserver } from "../src/server/file-observer/index.js";

const execFileAsync = promisify(execFile);
const ITERATIONS = readPositiveInteger("PASEO_WATCH_REPRO_ITERATIONS", 200);
const CHILD_TIMEOUT_MS = readPositiveInteger(
  "PASEO_WATCH_REPRO_TIMEOUT_MS",
  Math.max(45_000, ITERATIONS * 150),
);

interface ChildResult {
  backend: string;
  iterations: number;
  completed: number;
  teardownErrors: string[];
  elapsedMs: number;
  teardownP99Ms: number;
  callbacksAfterClose: number;
  fileDescriptorsBefore: number | null;
  fileDescriptorsAfter: number | null;
  rssGrowthMiB: number;
  observerBaselineRestored: boolean;
  assertionsPassed: boolean;
}

async function main(): Promise<void> {
  if (process.argv.includes("--child")) {
    process.stdout.write(`${JSON.stringify(await runChild())}\n`);
    return;
  }

  const startedAt = performance.now();
  let result;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [...process.execArgv, process.argv[1], "--child"],
      { env: process.env, maxBuffer: 1024 * 1024, timeout: CHILD_TIMEOUT_MS },
    );
    result = { ...JSON.parse(stdout.trim()), wedged: false };
  } catch (error) {
    const processError = error as Error & { killed?: boolean; signal?: string };
    result = {
      backend: "production",
      iterations: ITERATIONS,
      completed: 0,
      teardownErrors: [processError.message],
      elapsedMs: performance.now() - startedAt,
      wedged: processError.killed === true || processError.signal === "SIGTERM",
    };
  }
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, result }, null, 2)}\n`,
  );
  const productionPassed =
    "assertionsPassed" in result && result.assertionsPassed && result.wedged === false;
  if (!productionPassed) process.exitCode = 1;
}

async function runChild(): Promise<ChildResult> {
  const base = await mkdtemp(join(tmpdir(), "paseo-watch-repro-"));
  const observer = createFileObserver();
  const teardownErrors: string[] = [];
  const teardownDurations: number[] = [];
  const startedAt = performance.now();
  const warmupRoot = join(base, "warmup");
  await mkdir(warmupRoot);
  const warmupSubscription = await observer.subscribe(warmupRoot, () => undefined);
  await warmupSubscription.unsubscribe();
  await rm(warmupRoot, { recursive: true, force: true });
  const rssBefore = process.memoryUsage().rss;
  const fileDescriptorsBefore = await readFileDescriptorCount();
  const diagnosticsBefore = observer.getDiagnostics();
  let completed = 0;
  let callbacksAfterClose = 0;
  const sharedSubscription = await observer.subscribe(base, () => undefined);
  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const root = join(base, `worktree-${index}`);
      await mkdir(join(root, "nested"), { recursive: true });
      let closed = false;
      const subscription = await observer.subscribe(root, () => {
        if (closed) callbacksAfterClose += 1;
      });

      const command = process.platform === "win32" ? "cmd.exe" : "true";
      const commandArgs = process.platform === "win32" ? ["/c", "exit", "0"] : [];
      await Promise.all([
        writeFile(join(root, "nested", `edit-${index}.txt`), `${index}\n`),
        execFileAsync(command, commandArgs),
      ]);
      await writeFile(join(root, "archive-trigger"), "archive\n");
      const teardownStartedAt = performance.now();
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        teardownErrors.push(error instanceof Error ? error.message : String(error));
      }
      await subscription.unsubscribe().catch((error: unknown) => {
        teardownErrors.push(error instanceof Error ? error.message : String(error));
      });
      closed = true;
      teardownDurations.push(performance.now() - teardownStartedAt);
      completed += 1;
    }
  } finally {
    await sharedSubscription.unsubscribe().catch((error: unknown) => {
      teardownErrors.push(error instanceof Error ? error.message : String(error));
    });
    await observer.close();
    await rm(base, { recursive: true, force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const diagnosticsAfter = observer.getDiagnostics();
  const fileDescriptorsAfter = await readFileDescriptorCount();
  const rssGrowthMiB = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
  const teardownP99Ms = percentile(teardownDurations, 0.99);
  const observerBaselineRestored =
    diagnosticsAfter.activeObservationCount === diagnosticsBefore.activeObservationCount &&
    diagnosticsAfter.nativeHandleCount === diagnosticsBefore.nativeHandleCount &&
    diagnosticsAfter.pendingEventCount === diagnosticsBefore.pendingEventCount &&
    diagnosticsAfter.reconciliationInFlightCount === diagnosticsBefore.reconciliationInFlightCount;
  const assertionsPassed =
    completed === ITERATIONS &&
    teardownErrors.length === 0 &&
    callbacksAfterClose === 0 &&
    observerBaselineRestored &&
    (fileDescriptorsBefore === null || fileDescriptorsAfter === fileDescriptorsBefore) &&
    rssGrowthMiB < 128 &&
    teardownP99Ms < 1_000;
  return {
    backend: "production",
    iterations: ITERATIONS,
    completed,
    teardownErrors: [...new Set(teardownErrors)],
    elapsedMs: performance.now() - startedAt,
    teardownP99Ms,
    callbacksAfterClose,
    fileDescriptorsBefore,
    fileDescriptorsAfter,
    rssGrowthMiB,
    observerBaselineRestored,
    assertionsPassed,
  };
}

async function readFileDescriptorCount(): Promise<number | null> {
  if (process.platform !== "linux") return null;
  return (await readdir("/proc/self/fd")).length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

await main();
