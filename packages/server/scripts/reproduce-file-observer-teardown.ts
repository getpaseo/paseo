import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  getFileObserverDiagnostics,
  type SubscribeToFileChanges,
  subscribeToFileChanges,
} from "../src/server/file-observer/index.js";
import { subscribeToFileChangesWithParcel } from "./support/parcel-file-observer.js";

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
  const backend = process.argv.find((argument) => argument.startsWith("--backend="))?.split("=")[1];
  if (process.argv.includes("--child")) {
    if (!backend) throw new Error("Child requires --backend");
    const subscribe =
      backend === "node" ? subscribeToFileChanges : subscribeToFileChangesWithParcel;
    process.stdout.write(`${JSON.stringify(await runChild(backend, subscribe))}\n`);
    return;
  }

  const results = [];
  for (const name of backend ? [backend] : ["node", "parcel"]) {
    const startedAt = performance.now();
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [...process.execArgv, process.argv[1], `--backend=${name}`, "--child"],
        { env: process.env, maxBuffer: 1024 * 1024, timeout: CHILD_TIMEOUT_MS },
      );
      results.push({ ...JSON.parse(stdout.trim()), wedged: false });
    } catch (error) {
      const processError = error as Error & { killed?: boolean; signal?: string };
      results.push({
        backend: name,
        iterations: ITERATIONS,
        completed: 0,
        teardownErrors: [processError.message],
        elapsedMs: performance.now() - startedAt,
        wedged: processError.killed === true || processError.signal === "SIGTERM",
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2)}\n`,
  );
  const productionPassed = results
    .filter((result) => result.backend === "node")
    .every(
      (result) =>
        "assertionsPassed" in result && result.assertionsPassed && result.wedged === false,
    );
  if (!productionPassed) process.exitCode = 1;
}

async function runChild(backend: string, subscribe: SubscribeToFileChanges): Promise<ChildResult> {
  const base = await mkdtemp(join(tmpdir(), `paseo-watch-repro-${backend}-`));
  const teardownErrors: string[] = [];
  const teardownDurations: number[] = [];
  const startedAt = performance.now();
  const warmupRoot = join(base, "warmup");
  await mkdir(warmupRoot);
  const warmupSubscription = await subscribe(warmupRoot, () => undefined);
  await warmupSubscription.unsubscribe();
  await rm(warmupRoot, { recursive: true, force: true });
  const rssBefore = process.memoryUsage().rss;
  const fileDescriptorsBefore = await readFileDescriptorCount();
  const diagnosticsBefore = getFileObserverDiagnostics();
  let completed = 0;
  let callbacksAfterClose = 0;
  const sharedSubscription = await subscribe(base, () => undefined);
  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const root = join(base, `worktree-${index}`);
      await mkdir(join(root, "nested"), { recursive: true });
      let teardown: Promise<void> | null = null;
      let closed = false;
      let subscription!: Awaited<ReturnType<SubscribeToFileChanges>>;
      subscription = await subscribe(root, (_error, events) => {
        if (closed) callbacksAfterClose += 1;
        if (events.some((event) => event.path === join(root, "archive-trigger"))) {
          teardown ??= rm(root, { recursive: true, force: true }).then(() =>
            subscription.unsubscribe().then(() => {
              closed = true;
              return undefined;
            }),
          );
        }
      });

      const command = process.platform === "win32" ? "cmd.exe" : "true";
      const commandArgs = process.platform === "win32" ? ["/c", "exit", "0"] : [];
      await Promise.all([
        writeFile(join(root, "nested", `edit-${index}.txt`), `${index}\n`),
        execFileAsync(command, commandArgs),
      ]);
      await writeFile(join(root, "archive-trigger"), "archive\n");
      await waitFor(() => teardown !== null, 5_000);
      const teardownStartedAt = performance.now();
      try {
        await teardown;
      } catch (error) {
        teardownErrors.push(error instanceof Error ? error.message : String(error));
      }
      await subscription.unsubscribe().catch((error: unknown) => {
        teardownErrors.push(error instanceof Error ? error.message : String(error));
      });
      teardownDurations.push(performance.now() - teardownStartedAt);
      completed += 1;
    }
  } finally {
    await sharedSubscription.unsubscribe().catch((error: unknown) => {
      teardownErrors.push(error instanceof Error ? error.message : String(error));
    });
    await rm(base, { recursive: true, force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const diagnosticsAfter = getFileObserverDiagnostics();
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
    backend,
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for archive teardown");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

await main();
