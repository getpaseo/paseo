import { createHook, executionAsyncResource } from "node:async_hooks";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { MessagePort } from "node:worker_threads";

/** Measure main-thread work without charging idle IO or runner descheduling. */
export async function measureMainThreadWork<T>(label: string, action: () => T | Promise<T>) {
  // Node 22.20 supplies this API; the repository's older declarations omit it.
  const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
    process,
    "threadCpuUsage",
  );
  let blockingMs = 0;
  let filesystemRequests = 0;
  let yields = 0;
  let longestCallbackMs = 0;
  let longestCallbackCpuMs = 0;
  let longestGapMs = 0;
  let longestGcMs = 0;
  let gcCount = 0;
  let workerEvents = 0;
  let draining = false;
  const startedAt = performance.now();
  let previous = startedAt;
  let previousCpu = threadCpuUsage();
  let probe: ReturnType<typeof setInterval>;
  let drain: ReturnType<typeof setImmediate>;
  const callbacks = new Map<number, { wall: number; cpu: NodeJS.CpuUsage }>();
  const record = (wallMs: number, cpu: NodeJS.CpuUsage) => {
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    // Windows CPU accounting is coarse. Cap charged CPU by the real span so a
    // counter increment cannot inflate a short callback. Zero-CPU waits drop out.
    blockingMs = Math.max(blockingMs, Math.min(wallMs, cpuMs));
    if (wallMs > longestCallbackMs) {
      longestCallbackMs = wallMs;
      longestCallbackCpuMs = cpuMs;
    }
  };
  const observeGc = (entries: readonly PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime < startedAt) continue;
      gcCount++;
      longestGcMs = Math.max(longestGcMs, entry.duration);
    }
  };
  const gc = new PerformanceObserver((list) => observeGc(list.getEntries()));
  gc.observe({ entryTypes: ["gc"] });
  const activity = createHook({
    init(_id, type) {
      if (type.startsWith("FSREQ")) filesystemRequests++;
      if (!draining && type === "Immediate") yields++;
      if (type === "WORKER") workerEvents++;
    },
    before(id) {
      const resource = executionAsyncResource();
      if (resource === probe || resource === drain) return;
      if (resource instanceof MessagePort) workerEvents++;
      callbacks.set(id, { wall: performance.now(), cpu: threadCpuUsage() });
    },
    after(id) {
      const start = callbacks.get(id);
      if (!start) return;
      callbacks.delete(id);
      record(performance.now() - start.wall, threadCpuUsage(start.cpu));
    },
  }).enable();
  const sample = () => {
    const now = performance.now();
    const cpu = threadCpuUsage();
    const wallMs = now - previous;
    longestGapMs = Math.max(longestGapMs, wallMs);
    // Worker construction/message cloning can precede async_hooks.before.
    if (workerEvents) {
      blockingMs = Math.max(
        blockingMs,
        Math.min(wallMs, (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1_000),
      );
    }
    workerEvents = 0;
    previous = now;
    previousCpu = cpu;
  };
  probe = setInterval(sample, 1);
  let result: T;
  try {
    // The caller's current callback began before the hook was installed.
    const wall = performance.now();
    const cpu = threadCpuUsage();
    const pending = action();
    record(performance.now() - wall, threadCpuUsage(cpu));
    result = await pending;
    draining = true;
    await new Promise<void>((resolve) => {
      drain = setImmediate(resolve);
    });
    sample();
    observeGc(gc.takeRecords());
  } finally {
    clearInterval(probe);
    activity.disable();
    gc.disconnect();
  }
  // GC CPU inside callbacks is charged above. Elapsed GC spans, like elapsed
  // callback spans, include preemption and remain diagnostics rather than gates.
  process.stderr.write(
    `${label}: ${JSON.stringify({ blockingMs, filesystemRequests, yields, longestCallbackMs, longestCallbackCpuMs, longestGcMs, gcCount, longestGapMs })}\n`,
  );
  return { result, blockingMs, filesystemRequests, yields };
}
