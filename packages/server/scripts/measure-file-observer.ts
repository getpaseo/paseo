import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  createFileObserver,
  type FileChange,
  type FileObserverSubscription,
} from "../src/server/file-observer/index.js";

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
const MODE = resolveMode();
const LATE_IGNORED_DIRS = readPositiveInteger("PASEO_WATCH_BENCH_LATE_IGNORED_DIRS", 2_000);
const LATE_IGNORED_FILES = readPositiveInteger("PASEO_WATCH_BENCH_LATE_IGNORED_FILES", 20_000);
// directory-churn mode exercises removeSubtree/reconcileSubtree/paths.collapse
// in packages/server/src/server/file-observer/internal/native-recursive.ts,
// which the healthy and late-ignored fixtures never touch: they only
// mkdir/writeFile, and every delete happens after unsubscribe.
const CHURN_DIRECTORY_COUNT = readPositiveInteger("PASEO_WATCH_BENCH_CHURN_DIRECTORIES", 20_000);
const CHURN_FILES_PER_DIRECTORY = readPositiveInteger(
  "PASEO_WATCH_BENCH_CHURN_FILES_PER_DIRECTORY",
  3,
);
const CHURN_ROUNDS = readPositiveInteger("PASEO_WATCH_BENCH_CHURN_ROUNDS", 3);
const CHURN_DIRECTORIES_PER_ROUND = readPositiveInteger(
  "PASEO_WATCH_BENCH_CHURN_DIRECTORIES_PER_ROUND",
  500,
);
// Sustained rename churn (the production symptom this mode approximates) can
// leave a single reconciliation running for minutes once the tracked set is
// large; give it room to finish instead of calling that a timeout failure.
const CHURN_SETTLE_TIMEOUT_MS = readPositiveInteger(
  "PASEO_WATCH_BENCH_CHURN_SETTLE_TIMEOUT_MS",
  300_000,
);
// Sequential `await`-per-entry construction lets the observer's pending
// fs.stat() classifications drain between filesystem calls, so the storm this
// mode exists to reproduce never piles up: the sequential version could never
// push pendingClassificationCount past 32, nowhere near the 2,080 bound
// (32 concurrent + 2,048 queued) a later fix is measured against. Firing
// batches of concurrent mkdir/writeFile calls overwhelms the libuv threadpool
// that both the harness's own fs calls and the observer's classify() stat()
// calls share, which is what produces a real backlog. The batch size is
// derived from this process's actual open-file limit (see
// resolveLateIgnoredBatchSize below) rather than hardcoded, so a replay on a
// machine with a much lower `ulimit -n` (common on Linux/CI, historically on
// macOS too) degrades to a smaller burst instead of throwing EMFILE mid-run.
const LATE_IGNORED_BATCH_SIZE = resolveLateIgnoredBatchSize();
// Reuses the same descriptor-aware sizing as LATE_IGNORED_BATCH_SIZE above:
// directory-churn mode needs concurrent, not sequential, filesystem calls to
// outrun the audit's 500ms quiet window and force scopes to pile up.
const CHURN_BATCH_SIZE = resolveLateIgnoredBatchSize();
const execFileAsync = promisify(execFile);

type BenchMode = "healthy" | "late-ignored" | "directory-churn";

function resolveMode(): BenchMode {
  const raw = process.env.PASEO_WATCH_BENCH_MODE;
  if (raw === "late-ignored") return "late-ignored";
  if (raw === "directory-churn") return "directory-churn";
  return "healthy";
}

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
  lateIgnoredTrackedFileCount: number | null;
  peakPendingClassificationCount: number;
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
  // Absolute values (not deltas) read straight off diagnostics: the observer
  // instance is fresh per run, so "max"/"last" already scope to this run.
  maxReconciliationDurationMs: number;
  lastReconciliationDurationMs: number;
  // directory-churn mode only; null for healthy/late-ignored.
  nativeRenameEventCount: number | null;
  churnDirectoryCount: number | null;
  churnFileCount: number | null;
  churnRounds: number | null;
  churnDirectoriesChurned: number | null;
}

interface FixtureRoot {
  root: string;
  ignoredRoot: string;
  trackedRoot: string;
}

async function main(): Promise<void> {
  const isChild = process.argv.includes("--child");

  if (isChild) {
    process.stdout.write(`${JSON.stringify(await runMeasurement(1))}\n`);
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

function runMeasurement(run: number): Promise<Measurement> {
  return MODE === "directory-churn" ? measureDirectoryChurn(run) : measure(run);
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
      MODE === "healthy" ? mkdir(ignoredRoot, { recursive: true }) : Promise.resolve(),
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
        { ignore: MODE === "healthy" ? [ignoredRoot] : [] },
      ),
    ),
  );
  const setupMs = performance.now() - setupStarted;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const startupEvents = delivered.length;
  const kernelWatchCount = await readKernelWatchCount();

  let peakPendingClassificationCount = 0;
  let lateIgnoredTrackedFileCount: number | null = null;
  let samplePending: ReturnType<typeof setInterval> | undefined;

  try {
    samplePending = setInterval(() => {
      peakPendingClassificationCount = Math.max(
        peakPendingClassificationCount,
        observer.getDiagnostics().pendingClassificationCount,
      );
    }, 50);
    samplePending.unref();

    if (MODE === "late-ignored") {
      // The whole point: the ignored tree appears only after the observation
      // exists. Construction runs in concurrent batches (not one
      // mkdir/writeFile at a time) so filesystem events arrive faster than
      // the observer can classify them — otherwise nothing ever piles up.
      for (const target of roots) {
        await mkdir(target.ignoredRoot, { recursive: true });
        await runInBatches(LATE_IGNORED_DIRS, LATE_IGNORED_BATCH_SIZE, (index) =>
          mkdir(join(target.ignoredRoot, `package-${index}`), { recursive: true }),
        );
        await runInBatches(LATE_IGNORED_FILES, LATE_IGNORED_BATCH_SIZE, (index) =>
          writeFile(
            join(target.ignoredRoot, `package-${index % LATE_IGNORED_DIRS}`, `module-${index}.js`),
            `${index}\n`,
          ),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      lateIgnoredTrackedFileCount = observer.getDiagnostics().nativeTrackedFileCount;
    }

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
      lateIgnoredTrackedFileCount,
      peakPendingClassificationCount,
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
      maxReconciliationDurationMs: diagnosticsAfter.maxReconciliationDurationMs,
      lastReconciliationDurationMs: diagnosticsAfter.lastReconciliationDurationMs,
      nativeRenameEventCount: null,
      churnDirectoryCount: null,
      churnFileCount: null,
      churnRounds: null,
      churnDirectoriesChurned: null,
    };
  } finally {
    if (samplePending) clearInterval(samplePending);
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    await observer.close();
    await rm(base, { recursive: true, force: true });
  }
}

// directory-churn mode. Unlike healthy/late-ignored, this builds one large
// tracked tree and then repeatedly makes whole known directories disappear —
// the only way to invoke removeSubtree, reconcileSubtree, and paths.collapse
// in native-recursive.ts.
async function measureDirectoryChurn(run: number): Promise<Measurement> {
  const totalChurnTargets = CHURN_ROUNDS * CHURN_DIRECTORIES_PER_ROUND;
  if (totalChurnTargets > CHURN_DIRECTORY_COUNT) {
    throw new Error(
      `PASEO_WATCH_BENCH_CHURN_ROUNDS (${CHURN_ROUNDS}) * ` +
        `PASEO_WATCH_BENCH_CHURN_DIRECTORIES_PER_ROUND (${CHURN_DIRECTORIES_PER_ROUND}) = ` +
        `${totalChurnTargets} must not exceed PASEO_WATCH_BENCH_CHURN_DIRECTORIES ` +
        `(${CHURN_DIRECTORY_COUNT})`,
    );
  }

  const base = await mkdtemp(join(tmpdir(), "paseo-watch-churn-"));
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const observer = createFileObserver();
  let subscription: FileObserverSubscription | null = null;

  try {
    // 1. Build a large, entirely-tracked tree before subscribing. Nothing
    // here is ignored: removeSubtree and reconcileSubtree scale with the size
    // of `this.files` / `this.directories`, so the fixture needs a big
    // tracked set for their cost to show up at all.
    await runInBatches(CHURN_DIRECTORY_COUNT, CHURN_BATCH_SIZE, (index) =>
      mkdir(join(root, `dir-${index}`)),
    );
    await runInBatches(
      CHURN_DIRECTORY_COUNT * CHURN_FILES_PER_DIRECTORY,
      CHURN_BATCH_SIZE,
      (flatIndex) => {
        const directoryIndex = Math.floor(flatIndex / CHURN_FILES_PER_DIRECTORY);
        const fileIndex = flatIndex % CHURN_FILES_PER_DIRECTORY;
        return writeFile(
          join(root, `dir-${directoryIndex}`, `file-${fileIndex}.txt`),
          `${flatIndex}\n`,
        );
      },
    );

    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const diagnosticsBefore = observer.getDiagnostics();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
    const delivered: FileChange[] = [];
    let error: Error | null = null;

    const setupStarted = performance.now();
    subscription = await observer.subscribe(root, (nextError, events) => {
      error ??= nextError;
      delivered.push(...events);
    });
    const setupMs = performance.now() - setupStarted;

    // 2. Let the initial inventory settle before churning anything.
    const initialSettled = await waitFor(() => {
      const diagnostics = observer.getDiagnostics();
      return (
        diagnostics.pendingEventCount === 0 &&
        diagnostics.pendingReconciliationWorkCount === 0 &&
        diagnostics.reconciliationInFlightCount === 0
      );
    }, 120_000);
    if (!initialSettled) {
      throw new Error("Timed out waiting for directory-churn initial inventory to settle");
    }
    if (error) throw error;
    const startupEvents = delivered.length;
    const kernelWatchCount = await readKernelWatchCount();

    // 3. Drive directory churn. Each round deletes half of a batch of known
    // directories outright (their parent's next shallow scan finds them gone
    // and calls removeSubtree) and replaces the other half atomically in
    // place: rm the old directory, then rename a freshly built sibling onto
    // the same path. The backend's classify() stat() resolves after the
    // rename completes, sees a directory at a path it already knew as a
    // directory, and treats it as the directory itself changing —
    // populating recursiveScopes and driving reconcileSubtree. Firing every
    // round's operations concurrently, faster than the audit's 500ms quiet
    // window, is what forces the resulting scopes onto one large
    // reconciliation instead of many small ones, which is what the
    // production incident this mode approximates looked like.
    const diagnosticsBeforeChurn = observer.getDiagnostics();
    const churnCpuBefore = process.cpuUsage();
    const churnStarted = performance.now();
    let nextDirectoryIndex = 0;
    for (let round = 0; round < CHURN_ROUNDS; round += 1) {
      const batch: number[] = [];
      for (let i = 0; i < CHURN_DIRECTORIES_PER_ROUND; i += 1) {
        batch.push(nextDirectoryIndex);
        nextDirectoryIndex += 1;
      }
      const deleteCount = Math.floor(batch.length / 2);
      const deleteTargets = batch.slice(0, deleteCount);
      const replaceTargets = batch.slice(deleteCount);
      await runInBatches(deleteTargets.length, CHURN_BATCH_SIZE, (offset) =>
        rm(join(root, `dir-${deleteTargets[offset]}`), { recursive: true, force: true }),
      );
      await runInBatches(replaceTargets.length, CHURN_BATCH_SIZE, (offset) =>
        replaceDirectoryAtomically(
          join(root, `dir-${replaceTargets[offset]}`),
          CHURN_FILES_PER_DIRECTORY,
        ),
      );
    }
    const churnSettled = await waitFor(() => {
      const diagnostics = observer.getDiagnostics();
      return (
        diagnostics.pendingEventCount === 0 &&
        diagnostics.pendingReconciliationWorkCount === 0 &&
        diagnostics.reconciliationInFlightCount === 0
      );
    }, CHURN_SETTLE_TIMEOUT_MS);
    if (!churnSettled) {
      throw new Error(
        `Timed out waiting for directory-churn reconciliation to settle within ` +
          `${CHURN_SETTLE_TIMEOUT_MS}ms`,
      );
    }
    const churnDurationMs = performance.now() - churnStarted;
    const churnCpu = process.cpuUsage(churnCpuBefore);
    const churnCpuMs = (churnCpu.user + churnCpu.system) / 1_000;
    if (error) throw error;
    const diagnosticsAfterChurn = observer.getDiagnostics();

    const teardownStarted = performance.now();
    await subscription.unsubscribe();
    const teardownMs = performance.now() - teardownStarted;
    const diagnosticsAfter = observer.getDiagnostics();
    const cpu = process.cpuUsage(cpuBefore);
    eventLoopDelay.disable();

    return {
      backend: "production",
      run,
      setupMs,
      editLatencyMs: 0,
      editLatencyP50Ms: 0,
      editLatencyP95Ms: 0,
      editLatencyP99Ms: 0,
      burstDurationMs: churnDurationMs,
      burstCpuMs: churnCpuMs,
      sustainedDurationMs: 0,
      sustainedCpuMs: 0,
      sustainedScopedReconciliationCount: null,
      sustainedFullReconciliationCount: null,
      sustainedNativeEventCount: null,
      sustainedNativeChangeEventCount: null,
      sustainedNativeRenameEventCount: null,
      sustainedNativePathlessEventCount: null,
      sustainedNativeClassificationCount: null,
      sustainedNativeShallowScanCount: null,
      sustainedMissedPaths: 0,
      lateIgnoredTrackedFileCount: null,
      peakPendingClassificationCount: 0,
      teardownMs,
      startupEvents,
      deliveredEvents: delivered.length,
      // Nothing is ignored in this mode's fixture; see the comment at the
      // CHURN_DIRECTORY_COUNT declaration above.
      ignoredEvents: 0,
      missedTrackedPaths: 0,
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
      maxReconciliationDurationMs: diagnosticsAfter.maxReconciliationDurationMs,
      lastReconciliationDurationMs: diagnosticsAfter.lastReconciliationDurationMs,
      nativeRenameEventCount:
        diagnosticsAfterChurn.nativeRenameEventCount -
        diagnosticsBeforeChurn.nativeRenameEventCount,
      churnDirectoryCount: CHURN_DIRECTORY_COUNT,
      churnFileCount: CHURN_DIRECTORY_COUNT * CHURN_FILES_PER_DIRECTORY,
      churnRounds: CHURN_ROUNDS,
      churnDirectoriesChurned: totalChurnTargets,
    };
  } finally {
    if (subscription) await subscription.unsubscribe();
    await observer.close();
    await rm(base, { recursive: true, force: true });
  }
}

// Builds a fresh sibling directory, then rm+rename it onto `directory`. This
// is the atomic-replace pattern dev-server builds use to swap output
// directories in place, and the specific shape that drives reconcileSubtree:
// see the comment inside measureDirectoryChurn's churn loop above.
async function replaceDirectoryAtomically(directory: string, fileCount: number): Promise<void> {
  const staging = `${directory}.replacement`;
  await mkdir(staging);
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    await writeFile(join(staging, `file-${fileIndex}.txt`), `${fileIndex}\n`);
  }
  await rm(directory, { recursive: true, force: true });
  await rename(staging, directory);
}

function resolveLateIgnoredBatchSize(): number {
  // A batch this small still produces a genuine burst instead of degenerating
  // back toward the sequential, one-at-a-time construction this code
  // replaces — see the comment on LATE_IGNORED_BATCH_SIZE above for why a
  // burst is required at all.
  const floor = 64;
  // Never exceed this regardless of how generous the descriptor limit is.
  // 2,000 already produces peak pending classifications in the ~2,700-3,200
  // range on a high-limit machine, comfortably clearing the 2,080 bound the
  // later fix imposes, so there is no reason to risk more file descriptors
  // for a larger, noisier number.
  const ceiling = 2_000;
  // Used when this runtime cannot report its own descriptor limit at all.
  // Small enough to be safe under a default Linux/CI soft limit of roughly
  // 1,024-4,096, still large enough to produce a real burst.
  const fallback = 512;
  const softLimit = readOpenFileSoftLimit();
  if (softLimit === null) return fallback;
  // Leave headroom for everything else the process holds open at the same
  // time: stdio, the fixture's own already-created directories/files, the
  // observer's native watch handle, and Node's own bookkeeping fds.
  const quarter = Math.floor(softLimit / 4);
  return Math.min(ceiling, Math.max(floor, quarter));
}

function readOpenFileSoftLimit(): number | null {
  // Node's diagnostic report is the only cross-platform way to read this
  // process's own open-file (RLIMIT_NOFILE) soft limit without shelling out
  // to `ulimit -n`, which is a shell builtin with no direct Node API.
  // `header.fileDescriptorSoftLimit` is checked first for forward/backward
  // compatibility, but it does not exist on this script's tested runtime
  // (verified empirically: `undefined` on Node v24.15.0/darwin). The field
  // that does exist there, and is expected to exist on Linux too since it
  // comes from the same libuv getrlimit() call, is
  // `userLimits.open_files.soft`.
  let report: unknown;
  try {
    report = process.report?.getReport();
  } catch {
    return null;
  }
  if (typeof report !== "object" || report === null) return null;
  const asRecord = report as Record<string, unknown>;
  return (
    parseDescriptorLimit(readNestedField(asRecord, ["header", "fileDescriptorSoftLimit"])) ??
    parseDescriptorLimit(readNestedField(asRecord, ["userLimits", "open_files", "soft"]))
  );
}

function readNestedField(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseDescriptorLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().toLowerCase() === "unlimited") {
    return Number.POSITIVE_INFINITY;
  }
  return null;
}

async function runInBatches(
  count: number,
  batchSize: number,
  createEntry: (index: number) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const batch: Promise<unknown>[] = [];
    for (let index = start; index < end; index += 1) batch.push(createEntry(index));
    await Promise.all(batch);
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
    mode: MODE,
    churnDirectories: CHURN_DIRECTORY_COUNT,
    churnFilesPerDirectory: CHURN_FILES_PER_DIRECTORY,
    churnRounds: CHURN_ROUNDS,
    churnDirectoriesPerRound: CHURN_DIRECTORIES_PER_ROUND,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function evaluate(results: Measurement[]): {
  passed: boolean;
  failures: string[];
} {
  if (MODE === "directory-churn") {
    // This phase exists to characterize a known-bad code path (removeSubtree
    // and reconcileSubtree scanning the whole tracked set per disappeared
    // directory), not to gate CI on a threshold yet.
    return { passed: true, failures: [] };
  }
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
  // In late-ignored mode, nonzero ignoredEvents is the bug reproducing, not a
  // regression: the observer is deliberately given the ignored tree only
  // after it subscribes, so it has no way to exclude it yet.
  if (MODE !== "late-ignored" && result.ignoredEvents !== 0) {
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
