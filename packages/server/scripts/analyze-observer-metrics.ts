import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface Sample {
  uptimeSeconds: number;
  trackedFiles: number;
  renames: number;
  classifications: number;
  pendingClassifications: number;
  pendingWork: number;
  maxReconciliationMs: number;
  eventLoopMaxMs: number;
  rssBytes: number;
  failures: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Pino lines are prefixed with a plain-text timestamp; the JSON payload starts
// at the first `{`. Lines that aren't JSON (or aren't ws_runtime_metrics) are skipped.
function parseLogLine(line: string): Record<string, unknown> | undefined {
  const start = line.indexOf("{");
  if (start < 0) return undefined;
  try {
    return asRecord(JSON.parse(line.slice(start)));
  } catch {
    return undefined;
  }
}

function extractObserverRecord(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const workspaceService = asRecord(asRecord(root.git)?.workspaceService);
  return asRecord(workspaceService?.fileObserver);
}

function buildSample(root: Record<string, unknown>, observer: Record<string, unknown>): Sample {
  const eventLoopDelay = asRecord(root.eventLoopDelay);
  const memory = asRecord(root.memory);
  return {
    uptimeSeconds: asNumber(root.uptimeSeconds) ?? 0,
    trackedFiles: asNumber(observer.nativeTrackedFileCount) ?? 0,
    renames: asNumber(observer.nativeRenameEventCount) ?? 0,
    classifications: asNumber(observer.nativeClassificationCount) ?? 0,
    pendingClassifications: asNumber(observer.pendingClassificationCount) ?? 0,
    pendingWork: asNumber(observer.pendingReconciliationWorkCount) ?? 0,
    maxReconciliationMs: asNumber(observer.maxReconciliationDurationMs) ?? 0,
    eventLoopMaxMs: asNumber(eventLoopDelay?.maxMs) ?? 0,
    rssBytes: asNumber(memory?.rss) ?? 0,
    failures:
      (asNumber(observer.observerFailureCount) ?? 0) +
      (asNumber(observer.reconciliationFailureCount) ?? 0) +
      (asNumber(observer.directoryLimitFailureCount) ?? 0),
  };
}

async function readSamples(path: string): Promise<Sample[]> {
  const samples: Sample[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const root = parseLogLine(line);
    if (!root) continue;
    const observer = extractObserverRecord(root);
    if (!observer) continue;
    samples.push(buildSample(root, observer));
  }
  return samples;
}

// A daemon restart resets uptime, so a decrease starts a new run.
function splitRuns(samples: Sample[]): Sample[][] {
  const runs: Sample[][] = [];
  let current: Sample[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.uptimeSeconds < previous && current.length > 0) {
      runs.push(current);
      current = [];
    }
    current.push(sample);
    previous = sample.uptimeSeconds;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function peak(run: Sample[], select: (sample: Sample) => number): number {
  return run.reduce((highest, sample) => Math.max(highest, select(sample)), 0);
}

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: analyze-observer-metrics <path-to-daemon.log>");
  process.exit(1);
}

const runs = splitRuns(await readSamples(logPath));
const header = [
  "run".padStart(3),
  "samples".padStart(7),
  "hours".padStart(6),
  "peakTracked".padStart(11),
  "renames".padStart(10),
  "classify".padStart(10),
  "peakPendClass".padStart(13),
  "peakPendWork".padStart(12),
  "maxReconS".padStart(9),
  "peakLoopS".padStart(9),
  "peakRssMB".padStart(9),
  "fails".padStart(5),
].join(" ");
console.log(header);
runs.forEach((run, index) => {
  console.log(
    [
      String(index + 1).padStart(3),
      String(run.length).padStart(7),
      (run[run.length - 1].uptimeSeconds / 3600).toFixed(1).padStart(6),
      String(peak(run, (s) => s.trackedFiles)).padStart(11),
      String(peak(run, (s) => s.renames)).padStart(10),
      String(peak(run, (s) => s.classifications)).padStart(10),
      String(peak(run, (s) => s.pendingClassifications)).padStart(13),
      String(peak(run, (s) => s.pendingWork)).padStart(12),
      (peak(run, (s) => s.maxReconciliationMs) / 1000).toFixed(1).padStart(9),
      (peak(run, (s) => s.eventLoopMaxMs) / 1000).toFixed(1).padStart(9),
      (peak(run, (s) => s.rssBytes) / 1048576).toFixed(0).padStart(9),
      String(peak(run, (s) => s.failures)).padStart(5),
    ].join(" "),
  );
});
