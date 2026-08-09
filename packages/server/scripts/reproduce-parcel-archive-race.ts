import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  type FileObserverCallback,
  type SubscribeToFileChanges,
  subscribeToFileChanges,
} from "../src/server/file-observer/index.js";
import { subscribeToFileChangesWithParcel } from "./support/parcel-file-observer.js";

const execFileAsync = promisify(execFile);
const ITERATIONS = readPositiveInteger("PASEO_WATCH_RACE_ITERATIONS", 10);
const RUNS = readPositiveInteger("PASEO_WATCH_RACE_RUNS", 5);
const WIDTH = readPositiveInteger("PASEO_WATCH_RACE_WIDTH", 100);
const TIMEOUT_MS = readPositiveInteger("PASEO_WATCH_RACE_TIMEOUT_MS", 10_000);
const PRODUCTION_TIMEOUT_MS = readPositiveInteger("PASEO_WATCH_RACE_PRODUCTION_TIMEOUT_MS", 30_000);
const BACKEND = process.env.PASEO_WATCH_BACKEND;

interface ChildResult {
  backend: string;
  completed: number;
  iterations: number;
  missedMutations: number;
  excludedEvents: number;
  callbacksAfterClose: number;
  errors: string[];
  elapsedMs: number;
}

interface RunResult {
  backend: string;
  run: number;
  wedged: boolean;
  result?: ChildResult;
  message?: string;
}

if (process.argv.includes("--child")) {
  if (!BACKEND) throw new Error("Child requires PASEO_WATCH_BACKEND");
  await runChild(BACKEND);
} else {
  await runParent();
}

async function runParent(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("The targeted signal-pressure comparison is Linux-only");
  }
  const backends = BACKEND ? [BACKEND] : ["node", "parcel"];
  const results: RunResult[] = [];
  for (const backend of backends) {
    for (let run = 1; run <= RUNS; run += 1) {
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [...process.execArgv, process.argv[1]!, "--child"],
          {
            env: { ...process.env, PASEO_WATCH_BACKEND: backend },
            timeout: backend === "node" ? PRODUCTION_TIMEOUT_MS : TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
        );
        results.push({
          backend,
          run,
          wedged: false,
          result: JSON.parse(stdout.trim()) as ChildResult,
        });
      } catch (error) {
        const failure = error as Error & { killed?: boolean; signal?: string };
        results.push({
          backend,
          run,
          wedged: failure.killed === true || failure.signal === "SIGTERM",
          message: failure.message,
        });
      }
    }
  }

  const nodeResults = results.filter((result) => result.backend === "node");
  const parcelResults = results.filter((result) => result.backend === "parcel");
  const productionPassed = nodeResults.every(
    ({ wedged, result }) =>
      !wedged &&
      result?.completed === ITERATIONS &&
      result.missedMutations === 0 &&
      result.excludedEvents === 0 &&
      result.callbacksAfterClose === 0 &&
      result.errors.length === 0,
  );
  const comparatorReproduced =
    parcelResults.length === 0 || parcelResults.some(({ wedged }) => wedged);
  process.stdout.write(
    `${JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        productionPassed,
        comparatorReproduced,
        results,
      },
      null,
      2,
    )}\n`,
  );
  if (!productionPassed || !comparatorReproduced) process.exitCode = 1;
}

async function runChild(backend: string): Promise<void> {
  const subscribe = selectBackend(backend);
  const base = await mkdtemp(join(tmpdir(), "paseo-file-observer-archive-race-"));
  const childPressure = setInterval(() => spawn("true").on("error", () => undefined), 1);
  const targetedSignalPressure = startTargetedSignalPressure();
  const startedAt = performance.now();
  const errors = new Set<string>();
  let completed = 0;
  let missedMutations = 0;
  let excludedEvents = 0;
  let callbacksAfterClose = 0;
  const keepAlive = await subscribe(base, recordError(errors));
  try {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const root = join(base, `worktree-${iteration}`);
      const ignored = join(root, "ignored");
      await Promise.all(
        Array.from({ length: WIDTH }, async (_, index) => {
          const directory = join(root, `dir-${index}`, "nested");
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, "file.txt"), "before\n");
        }),
      );
      await mkdir(ignored);
      const observed = new Set<string>();
      let closed = false;
      const subscription = await subscribe(
        root,
        (error, events) => {
          if (error) errors.add(error.message);
          if (closed) callbacksAfterClose += 1;
          for (const event of events) {
            observed.add(event.path);
            if (event.path === ignored || event.path.startsWith(`${ignored}/`)) excludedEvents += 1;
          }
        },
        { ignore: [ignored] },
      );
      const marker = join(root, `observed-${iteration}.txt`);
      await Promise.all([writeFile(marker, "observed\n"), writeFile(join(ignored, "noise"), "x")]);
      try {
        await waitFor(() => observed.has(marker), 2_000);
      } catch {
        missedMutations += 1;
      }

      const churn = Promise.allSettled(
        Array.from({ length: WIDTH }, (_, index) =>
          writeFile(join(root, `dir-${index}`, "nested", "file.txt"), "after\n"),
        ),
      );
      const results = await Promise.allSettled([
        subscription.unsubscribe().then(() => {
          closed = true;
          return undefined;
        }),
        rm(root, { recursive: true, force: true }),
        churn,
      ]);
      for (const result of results) {
        if (result.status === "rejected" && !isMissingPathError(result.reason)) {
          errors.add(
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          );
        }
      }
      completed += 1;
    }
  } finally {
    clearInterval(childPressure);
    targetedSignalPressure.kill();
    await keepAlive.unsubscribe().catch((error: unknown) => {
      errors.add(error instanceof Error ? error.message : String(error));
    });
    await rm(base, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({
      backend,
      iterations: ITERATIONS,
      completed,
      missedMutations,
      excludedEvents,
      callbacksAfterClose,
      errors: [...errors],
      elapsedMs: performance.now() - startedAt,
    } satisfies ChildResult)}\n`,
  );
}

function selectBackend(backend: string): SubscribeToFileChanges {
  if (backend === "node") return subscribeToFileChanges;
  if (backend === "parcel") return subscribeToFileChangesWithParcel;
  throw new Error(`Unknown backend: ${backend}`);
}

function recordError(errors: Set<string>): FileObserverCallback {
  return (error) => {
    if (error) errors.add(error.message);
  };
}

function startTargetedSignalPressure() {
  let syscallNumber: number | null = null;
  if (process.arch === "x64") syscallNumber = 234;
  if (process.arch === "arm64") syscallNumber = 131;
  if (syscallNumber === null) throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  const script = [
    "import ctypes, os, signal, sys, time",
    "pid, number = int(sys.argv[1]), int(sys.argv[2])",
    "syscall = ctypes.CDLL(None, use_errno=True).syscall",
    "while True:",
    "  try:",
    "    tids = [int(value) for value in os.listdir(f'/proc/{pid}/task')]",
    "  except FileNotFoundError:",
    "    break",
    "  for tid in tids:",
    "    if tid != pid:",
    "      syscall(number, pid, tid, signal.SIGCHLD)",
    "  time.sleep(0.0005)",
  ].join("\n");
  return spawn("python3", ["-c", script, String(process.pid), String(syscallNumber)], {
    stdio: "ignore",
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for observed mutation");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
