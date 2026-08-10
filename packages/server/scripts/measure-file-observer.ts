import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { createFileObserver, type FileChange } from "../src/server/file-observer/index.js";

const DIRECTORY_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_DIRS", 500);
const ROOT_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_ROOTS", 1);
const IGNORED_FILE_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_IGNORED_FILES", 2_000);
const PREEXISTING_FILE_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_PREEXISTING_FILES", 1_000);
const EDIT_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_EDITS", 100);
const SUSTAINED_EDIT_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_SUSTAINED_EDITS", 20);
const SUSTAINED_EDIT_INTERVAL_MS = readPositiveInteger(
  "PASEO_WATCH_BENCH_SUSTAINED_INTERVAL_MS",
  500,
);
const REPETITIONS = readPositiveInteger("PASEO_WATCH_BENCH_REPETITIONS", 1);
const execFileAsync = promisify(execFile);

interface Measurement {
  backend: string;
  run: number;
  setupMs: number;
  editLatencyMs: number;
  editLatencyP50Ms: number;
  editLatencyP95Ms: number;
  editLatencyP99Ms: number;
  burstDurationMs: number;
  burstCpuMs: number;
  sustainedDurationMs: number;
  sustainedCpuMs: number;
  sustainedScopedReconciliationCount: number | null;
  sustainedFullReconciliationCount: number | null;
  sustainedNativeEventCount: number | null;
  sustainedNativeChangeEventCount: number | null;
  sustainedNativeRenameEventCount: number | null;
  sustainedNativePathlessEventCount: number | null;
  sustainedNativeClassificationCount: number | null;
  sustainedNativeShallowScanCount: number | null;
  sustainedMissedPaths: number;
  teardownMs: number;
  startupEvents: number;
  deliveredEvents: number;
  ignoredEvents: number;
  missedTrackedPaths: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssDeltaMiB: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  kernelWatchCount: number | null;
  scopedReconciliationCount: number | null;
  fullReconciliationCount: number | null;
}

interface FixtureRoot {
  root: string;
  ignoredRoot: string;
  trackedRoot: string;
}

async function main(): Promise<void> {
  const isChild = process.argv.includes("--child");

  if (isChild) {
    process.stdout.write(`${JSON.stringify(await measure(1))}\n`);
    return;
  }

  const results: Measurement[] = [];
  for (let run = 1; run <= REPETITIONS; run += 1) {
    results.push(await measureInChild(run));
  }
  const evaluation = evaluate(results);
  process.stdout.write(
    `${JSON.stringify({ fixture: fixtureDescription(), evaluation, results }, null, 2)}\n`,
  );
  if (!evaluation.passed) process.exitCode = 1;
}

async function measureInChild(run: number): Promise<Measurement> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [...process.execArgv, process.argv[1], "--child"],
    { env: process.env, maxBuffer: 1024 * 1024 },
  );
  return { ...(JSON.parse(stdout.trim()) as Measurement), run };
}

async function measure(run: number): Promise<Measurement> {
  const base = await mkdtemp(join(tmpdir(), "paseo-watch-"));
  const observer = createFileObserver();
  const roots: FixtureRoot[] = [];
  for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
    const root = join(base, `worktree-${rootIndex}`);
    const ignoredRoot = join(root, "ignored");
    const trackedRoot = join(root, "tracked");
    await Promise.all([
      mkdir(ignoredRoot, { recursive: true }),
      mkdir(trackedRoot, { recursive: true }),
    ]);
    for (let index = 0; index < DIRECTORY_COUNT; index += 1) {
      await mkdir(join(trackedRoot, `directory-${index}`));
    }
    await Promise.all(
      Array.from({ length: PREEXISTING_FILE_COUNT }, (_, index) =>
        writeFile(
          join(trackedRoot, `directory-${index % DIRECTORY_COUNT}`, `existing-${index}.txt`),
          `${index}\n`,
        ),
      ),
    );
    roots.push({ root, ignoredRoot, trackedRoot });
  }
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const diagnosticsBefore = observer.getDiagnostics();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const delivered: FileChange[] = [];
  const firstObservedAt = new Map<string, number>();
  let error: Error | null = null;
  const setupStarted = performance.now();
  const subscriptions = await Promise.all(
    roots.map(({ root, ignoredRoot }) =>
      observer.subscribe(
        root,
        (nextError, events) => {
          error ??= nextError;
          delivered.push(...events);
          for (const event of events) {
            if (!firstObservedAt.has(event.path))
              firstObservedAt.set(event.path, performance.now());
          }
        },
        { ignore: [ignoredRoot] },
      ),
    ),
  );
  const setupMs = performance.now() - setupStarted;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const startupEvents = delivered.length;
  const kernelWatchCount = await readKernelWatchCount();

  try {
    for (let index = 0; index < IGNORED_FILE_COUNT; index += 1) {
      const target = roots[index % roots.length];
      await writeFile(join(target.ignoredRoot, `artifact-${index}.txt`), `${index}\n`);
    }
    const trackedPaths: string[] = [];
    const writtenAt = new Map<string, number>();
    const burstCpuBefore = process.cpuUsage();
    const editStarted = performance.now();
    for (let index = 0; index < EDIT_COUNT; index += 1) {
      const target = roots[index % roots.length];
      const path = join(
        target.trackedRoot,
        `directory-${Math.floor(index / roots.length) % DIRECTORY_COUNT}`,
        `edit-${index}.txt`,
      );
      trackedPaths.push(path);
      await writeFile(path, `${index}\n`);
      writtenAt.set(path, performance.now());
    }
    await waitFor(
      () => trackedPaths.every((path) => delivered.some((event) => event.path === path)),
      10_000,
    );
    const editLatencyMs = performance.now() - editStarted;
    const observedLatencies = trackedPaths.map(
      (path) =>
        (firstObservedAt.get(path) ?? performance.now()) - (writtenAt.get(path) ?? editStarted),
    );
    if (error) throw error;

    const burstSettled = await waitFor(() => {
      const diagnostics = observer.getDiagnostics();
      return (
        diagnostics.pendingEventCount === 0 &&
        diagnostics.pendingReconciliationWorkCount === 0 &&
        diagnostics.reconciliationInFlightCount === 0
      );
    }, 30_000);
    if (!burstSettled) throw new Error("Timed out waiting for observer reconciliation to settle");
    const burstDurationMs = performance.now() - editStarted;
    const burstCpu = process.cpuUsage(burstCpuBefore);
    const burstCpuMs = (burstCpu.user + burstCpu.system) / 1_000;

    const sustainedPaths: string[] = [];
    const diagnosticsBeforeSustained = observer.getDiagnostics();
    const sustainedCpuBefore = process.cpuUsage();
    const sustainedStarted = performance.now();
    for (let index = 0; index < SUSTAINED_EDIT_COUNT; index += 1) {
      const target = roots[index % roots.length];
      const path = join(target.trackedRoot, `sustained-${index}.txt`);
      sustainedPaths.push(path);
      await writeFile(path, `${index}\n`);
      await new Promise((resolve) => setTimeout(resolve, SUSTAINED_EDIT_INTERVAL_MS));
    }
    await waitFor(
      () => sustainedPaths.every((path) => delivered.some((event) => event.path === path)),
      10_000,
    );
    const sustainedSettled = await waitFor(() => {
      const diagnostics = observer.getDiagnostics();
      return (
        diagnostics.pendingEventCount === 0 &&
        diagnostics.pendingReconciliationWorkCount === 0 &&
        diagnostics.reconciliationInFlightCount === 0
      );
    }, 30_000);
    if (!sustainedSettled) {
      throw new Error("Timed out waiting for sustained observer reconciliation to settle");
    }
    const sustainedDurationMs = performance.now() - sustainedStarted;
    const sustainedCpu = process.cpuUsage(sustainedCpuBefore);
    const sustainedCpuMs = (sustainedCpu.user + sustainedCpu.system) / 1_000;
    const diagnosticsAfterSustained = observer.getDiagnostics();

    const teardownStarted = performance.now();
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    const teardownMs = performance.now() - teardownStarted;
    const diagnosticsAfter = observer.getDiagnostics();
    const cpu = process.cpuUsage(cpuBefore);
    eventLoopDelay.disable();
    return {
      backend: "production",
      run,
      setupMs,
      editLatencyMs,
      editLatencyP50Ms: percentile(observedLatencies, 0.5),
      editLatencyP95Ms: percentile(observedLatencies, 0.95),
      editLatencyP99Ms: percentile(observedLatencies, 0.99),
      burstDurationMs,
      burstCpuMs,
      sustainedDurationMs,
      sustainedCpuMs,
      sustainedScopedReconciliationCount:
        diagnosticsAfterSustained.scopedReconciliationCount -
        diagnosticsBeforeSustained.scopedReconciliationCount,
      sustainedFullReconciliationCount:
        diagnosticsAfterSustained.fullReconciliationCount -
        diagnosticsBeforeSustained.fullReconciliationCount,
      sustainedNativeEventCount:
        diagnosticsAfterSustained.nativeEventCount - diagnosticsBeforeSustained.nativeEventCount,
      sustainedNativeChangeEventCount:
        diagnosticsAfterSustained.nativeChangeEventCount -
        diagnosticsBeforeSustained.nativeChangeEventCount,
      sustainedNativeRenameEventCount:
        diagnosticsAfterSustained.nativeRenameEventCount -
        diagnosticsBeforeSustained.nativeRenameEventCount,
      sustainedNativePathlessEventCount:
        diagnosticsAfterSustained.nativePathlessEventCount -
        diagnosticsBeforeSustained.nativePathlessEventCount,
      sustainedNativeClassificationCount:
        diagnosticsAfterSustained.nativeClassificationCount -
        diagnosticsBeforeSustained.nativeClassificationCount,
      sustainedNativeShallowScanCount:
        diagnosticsAfterSustained.nativeShallowScanCount -
        diagnosticsBeforeSustained.nativeShallowScanCount,
      sustainedMissedPaths: sustainedPaths.filter(
        (path) => !delivered.some((event) => event.path === path),
      ).length,
      teardownMs,
      startupEvents,
      deliveredEvents: delivered.length,
      ignoredEvents: delivered.filter((event) =>
        roots.some(({ ignoredRoot }) => event.path.startsWith(ignoredRoot)),
      ).length,
      missedTrackedPaths: trackedPaths.filter(
        (path) => !delivered.some((event) => event.path === path),
      ).length,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      rssDeltaMiB: (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
      eventLoopDelayP99Ms: eventLoopDelay.percentile(99) / 1_000_000,
      eventLoopDelayMaxMs: eventLoopDelay.max / 1_000_000,
      kernelWatchCount,
      scopedReconciliationCount:
        diagnosticsAfter.scopedReconciliationCount - diagnosticsBefore.scopedReconciliationCount,
      fullReconciliationCount:
        diagnosticsAfter.fullReconciliationCount - diagnosticsBefore.fullReconciliationCount,
    };
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    await observer.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function readKernelWatchCount(): Promise<number | null> {
  if (process.platform !== "linux") return null;
  let count = 0;
  for (const entry of await readdir("/proc/self/fdinfo")) {
    const contents = await readFile(join("/proc/self/fdinfo", entry), "utf8").catch(() => "");
    count += contents.split("\n").filter((line) => line.startsWith("inotify wd:")).length;
  }
  return count;
}

function fixtureDescription() {
  return {
    directoriesPerRoot: DIRECTORY_COUNT,
    totalDirectories: DIRECTORY_COUNT * ROOT_COUNT,
    roots: ROOT_COUNT,
    ignoredFiles: IGNORED_FILE_COUNT,
    preexistingFilesPerRoot: PREEXISTING_FILE_COUNT,
    trackedEdits: EDIT_COUNT,
    sustainedEdits: SUSTAINED_EDIT_COUNT,
    sustainedEditIntervalMs: SUSTAINED_EDIT_INTERVAL_MS,
    repetitions: REPETITIONS,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function evaluate(results: Measurement[]): {
  passed: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  for (const result of results) {
    evaluateStandaloneResult(result, failures);
  }
  return { passed: failures.length === 0, failures };
}

function evaluateStandaloneResult(result: Measurement, failures: string[]): void {
  if (result.missedTrackedPaths !== 0) {
    failures.push(`observer missed ${result.missedTrackedPaths} tracked paths`);
  }
  if (result.ignoredEvents !== 0) {
    failures.push(`observer emitted ${result.ignoredEvents} excluded events`);
  }
  if (result.sustainedMissedPaths !== 0) {
    failures.push(`observer missed ${result.sustainedMissedPaths} sustained paths`);
  }
  if (result.teardownMs >= 1_000) {
    failures.push(`observer teardown took ${result.teardownMs.toFixed(1)}ms`);
  }
  if ((result.sustainedFullReconciliationCount ?? 0) > 0) {
    failures.push(
      `node ran ${result.sustainedFullReconciliationCount} full reconciliations during sustained writes`,
    );
  }
  const setupLimitMs = process.platform === "win32" ? 8_000 : 1_000;
  if (result.setupMs > setupLimitMs) {
    failures.push(
      `node setup ${result.setupMs.toFixed(1)}ms exceeded the ${setupLimitMs}ms per-run limit on run ${result.run}`,
    );
  }
  if (result.burstDurationMs > 60_000) {
    failures.push(
      `node burst recovery ${result.burstDurationMs.toFixed(1)}ms exceeded the 60000ms per-run limit on run ${result.run}`,
    );
  }
  // The production observer repairs omitted native siblings with one shallow
  // directory diff per touched directory; keep that bounded allowance isolated
  // to burst recovery rather than weakening steady-state CPU or correctness.
  const burstCpuLimitMs = Math.max(6_000, result.burstDurationMs * 0.5);
  if (result.burstCpuMs > burstCpuLimitMs) {
    failures.push(
      `node burst CPU ${result.burstCpuMs.toFixed(1)}ms exceeded the ${burstCpuLimitMs.toFixed(1)}ms per-run limit on run ${result.run}`,
    );
  }
  if (result.eventLoopDelayP99Ms > 250) {
    failures.push(
      `node event-loop p99 ${result.eventLoopDelayP99Ms.toFixed(1)}ms exceeded the 250ms per-run limit on run ${result.run}`,
    );
  }
  const sustainedCpuLimitMs = result.sustainedDurationMs * 0.25;
  if (result.sustainedCpuMs > sustainedCpuLimitMs) {
    failures.push(
      `node sustained-create CPU ${result.sustainedCpuMs.toFixed(1)}ms exceeded the ${sustainedCpuLimitMs.toFixed(1)}ms per-run limit on run ${result.run}`,
    );
  }
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

await main();
