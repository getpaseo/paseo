import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  type FileChange,
  type SubscribeToFileChanges,
  subscribeToFileChanges,
} from "../src/server/file-observer/index.js";
import { subscribeToFileChangesWithParcel } from "./support/parcel-file-observer.js";

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
  sustainedDurationMs: number;
  sustainedCpuMs: number;
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
}

interface FixtureRoot {
  root: string;
  ignoredRoot: string;
  trackedRoot: string;
}

async function main(): Promise<void> {
  const requestedBackend = process.argv
    .find((argument) => argument.startsWith("--backend="))
    ?.split("=")[1];
  const isChild = process.argv.includes("--child");
  const backends: Array<[string, SubscribeToFileChanges]> = [
    ["node", subscribeToFileChanges],
    ["parcel", subscribeToFileChangesWithParcel],
  ];
  const selected = requestedBackend
    ? backends.filter(([name]) => name === requestedBackend)
    : backends;
  if (selected.length === 0) throw new Error(`Unknown backend: ${requestedBackend}`);

  if (isChild) {
    const [name, subscribe] = selected[0];
    process.stdout.write(`${JSON.stringify(await measure(name, subscribe, 1))}\n`);
    return;
  }

  const results: Measurement[] = [];
  for (let run = 1; run <= REPETITIONS; run += 1) {
    for (const [name] of selected) results.push(await measureInChild(name, run));
  }
  const evaluation = evaluate(results);
  process.stdout.write(
    `${JSON.stringify({ fixture: fixtureDescription(), evaluation, results }, null, 2)}\n`,
  );
  if (!evaluation.passed) process.exitCode = 1;
}

async function measureInChild(backend: string, run: number): Promise<Measurement> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [...process.execArgv, process.argv[1], `--backend=${backend}`, "--child"],
    { env: process.env, maxBuffer: 1024 * 1024 },
  );
  return { ...(JSON.parse(stdout.trim()) as Measurement), run };
}

async function measure(
  backend: string,
  subscribe: SubscribeToFileChanges,
  run: number,
): Promise<Measurement> {
  const base = await mkdtemp(join(tmpdir(), `paseo-watch-${backend}-`));
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
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const delivered: FileChange[] = [];
  const firstObservedAt = new Map<string, number>();
  let error: Error | null = null;
  const setupStarted = performance.now();
  const subscriptions = await Promise.all(
    roots.map(({ root, ignoredRoot }) =>
      subscribe(
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

    const sustainedPaths: string[] = [];
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
    const sustainedDurationMs = performance.now() - sustainedStarted;
    const sustainedCpu = process.cpuUsage(sustainedCpuBefore);
    const sustainedCpuMs = (sustainedCpu.user + sustainedCpu.system) / 1_000;

    const teardownStarted = performance.now();
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
    const teardownMs = performance.now() - teardownStarted;
    const cpu = process.cpuUsage(cpuBefore);
    eventLoopDelay.disable();
    return {
      backend,
      run,
      setupMs,
      editLatencyMs,
      editLatencyP50Ms: percentile(observedLatencies, 0.5),
      editLatencyP95Ms: percentile(observedLatencies, 0.95),
      editLatencyP99Ms: percentile(observedLatencies, 0.99),
      sustainedDurationMs,
      sustainedCpuMs,
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
    };
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
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
  comparatorFindings: string[];
} {
  const failures: string[] = [];
  const comparatorFindings: string[] = [];
  for (const result of results) {
    const findings = result.backend === "node" ? failures : comparatorFindings;
    if (result.missedTrackedPaths !== 0) {
      findings.push(`${result.backend} missed ${result.missedTrackedPaths} tracked paths`);
    }
    if (result.ignoredEvents !== 0) {
      findings.push(`${result.backend} emitted ${result.ignoredEvents} excluded events`);
    }
    if (result.sustainedMissedPaths !== 0) {
      findings.push(`${result.backend} missed ${result.sustainedMissedPaths} sustained paths`);
    }
    if (result.teardownMs >= 1_000) {
      failures.push(`${result.backend} teardown took ${result.teardownMs.toFixed(1)}ms`);
    }
  }
  const nodeRuns = results.filter((result) => result.backend === "node");
  const parcelRuns = results.filter((result) => result.backend === "parcel");
  for (let index = 0; index < Math.min(nodeRuns.length, parcelRuns.length); index += 1) {
    const node = nodeRuns[index];
    const parcel = parcelRuns[index];
    if (node.setupMs > parcel.setupMs * 8)
      failures.push(`node setup exceeded 8x Parcel on run ${node.run}`);
    if (
      node.missedTrackedPaths === 0 &&
      parcel.missedTrackedPaths === 0 &&
      node.editLatencyMs > parcel.editLatencyMs * 4
    ) {
      failures.push(`node edit completion exceeded 4x Parcel on run ${node.run}`);
    }
    if (node.eventLoopDelayMaxMs > parcel.eventLoopDelayMaxMs * 4 + 100) {
      failures.push(`node event-loop delay exceeded the comparison budget on run ${node.run}`);
    }
    const sustainedCpuBudgetMs = Math.max(
      parcel.sustainedCpuMs * 4,
      node.sustainedDurationMs * 0.15,
    );
    if (node.sustainedCpuMs > sustainedCpuBudgetMs) {
      failures.push(
        `node sustained-create CPU ${node.sustainedCpuMs.toFixed(1)}ms exceeded ${sustainedCpuBudgetMs.toFixed(1)}ms on run ${node.run}`,
      );
    }
  }
  return { passed: failures.length === 0, failures, comparatorFindings };
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
