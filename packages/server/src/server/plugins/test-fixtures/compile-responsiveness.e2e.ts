import assert from "node:assert/strict";
import { createHook, executionAsyncResource } from "node:async_hooks";
import { open as openFile, writeFile } from "node:fs/promises";
import { performance, PerformanceObserver } from "node:perf_hooks";
import path from "node:path";
import { MessagePort } from "node:worker_threads";
import pino from "pino";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { PluginService } from "../index.js";

// A fresh process excludes the E2E harness's transform/bootstrap garbage from
// the compiler measurement. All work and dependencies below are real.
const directory = process.argv[2];
assert.ok(directory, "Fixture directory is required");
const results: { blockingMs: number }[] = [];
await writeFile(
  path.join(directory, "paseo-plugin.json"),
  JSON.stringify({ id: "responsive-build" }),
);
// Erased types stress TypeScript's AST walk without a multi-MiB runtime bundle.
// Payload transfer is a different cost from import validation.
const entryFile = await openFile(path.join(directory, "index.client.ts"), "w");
try {
  await entryFile.write("type FixtureValues = [");
  for (let offset = 0; offset < 350_000; offset += 10_000) {
    await entryFile.write(
      Array.from({ length: 10_000 }, (_, index) => offset + index).join(",") + ",",
    );
  }
  await entryFile.write(
    ']; export default function contribute() { return () => "compiled fixture"; }',
  );
} finally {
  await entryFile.close();
}
const store = new DaemonConfigStore(directory, {
  mcp: { injectIntoAgents: true },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  appendSystemPrompt: "",
  pluginsEnabled: true,
  plugins: {
    "responsive-build": { source: "directory", path: directory, enabled: false },
  },
});
const service = new PluginService(pino({ level: "silent" }), store, "0.4.0");
await service.start();
try {
  for (const action of [
    () => service.enablePlugin("responsive-build"),
    () => service.reloadPlugin("responsive-build"),
  ]) {
    // Node 22.19+ exposes per-thread CPU accounting; the repository's older
    // Node declarations do not include it yet. .tool-versions pins Node 22.20.
    const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
      process,
      "threadCpuUsage",
    );
    const startedAt = performance.now();
    let previous = startedAt;
    let cpu = threadCpuUsage();
    let longestWall = 0;
    let longestBlocking = 0;
    let longestWallCpu = 0;
    let workerStarts = 0;
    let portCallbacks = 0;
    let longestWallEvents = { workerStarts: 0, portCallbacks: 0 };
    let longestBlockingWindow = { wallMs: 0, cpuMs: 0, resource: "" };
    let probe: ReturnType<typeof setInterval>;
    const callbacks = new Map<number, { wall: number; cpu: NodeJS.CpuUsage; resource: string }>();
    const recordBlocking = (
      blockingMs: number,
      window: { wallMs: number; cpuMs: number; resource: string },
    ) => {
      if (blockingMs > longestBlocking) {
        longestBlocking = blockingMs;
        longestBlockingWindow = window;
      }
    };
    let longestGc = 0;
    const observeGc = (entries: readonly import("node:perf_hooks").PerformanceEntry[]) => {
      for (const entry of entries) {
        if (entry.startTime >= startedAt) longestGc = Math.max(longestGc, entry.duration);
      }
    };
    const gc = new PerformanceObserver((list) => observeGc(list.getEntries()));
    gc.observe({ entryTypes: ["gc"] });
    // Measure work within callbacks, not CPU-counter increments attributed to
    // the idle interval between them. Exclude this probe's own timer callback.
    const activity = createHook({
      init(_id, type) {
        if (type === "WORKER") workerStarts++;
      },
      before(id) {
        const resource = executionAsyncResource();
        if (resource instanceof MessagePort) portCallbacks++;
        if (resource === probe) return;
        callbacks.set(id, {
          wall: performance.now(),
          cpu: threadCpuUsage(),
          resource: Object.prototype.toString.call(resource),
        });
      },
      after(id) {
        const start = callbacks.get(id);
        if (!start) return;
        callbacks.delete(id);
        const wallMs = performance.now() - start.wall;
        const { user, system } = threadCpuUsage(start.cpu);
        const cpuMs = (user + system) / 1_000;
        // A callback prevents the loop from serving IO for its entire span.
        // Use the high-resolution clock, not Windows' coarse CPU increments.
        recordBlocking(wallMs, { wallMs, cpuMs, resource: start.resource });
      },
    }).enable();
    const sample = () => {
      const now = performance.now();
      const currentCpu = threadCpuUsage();
      const wallMs = now - previous;
      const cpuMs = (currentCpu.user - cpu.user + currentCpu.system - cpu.system) / 1_000;
      // Native worker construction and message deserialization can precede
      // async_hooks.before. Include their interval when those events occurred.
      if (workerStarts || portCallbacks) {
        recordBlocking(Math.min(wallMs, cpuMs), {
          wallMs,
          cpuMs,
          resource: "worker/port interval",
        });
      }
      if (wallMs > longestWall) {
        longestWall = wallMs;
        longestWallCpu = cpuMs;
        longestWallEvents = { workerStarts, portCallbacks };
      }
      workerStarts = 0;
      portCallbacks = 0;
      previous = now;
      cpu = currentCpu;
    };
    // Sleep between probes: a continuously runnable setImmediate loop consumes
    // a core while the worker compiles. Raw gaps remain diagnostics; the
    // assertion measures elapsed daemon-thread callback spans and GC pauses.
    probe = setInterval(sample, 1);
    try {
      // The caller's current callback began before the hook was enabled.
      // Include synchronous work before the action's first await explicitly.
      const actionStartedAt = performance.now();
      const actionCpu = threadCpuUsage();
      const pending = action();
      const actionWallMs = performance.now() - actionStartedAt;
      const actionCost = threadCpuUsage(actionCpu);
      recordBlocking(actionWallMs, {
        wallMs: actionWallMs,
        cpuMs: (actionCost.user + actionCost.system) / 1_000,
        resource: "action()",
      });
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sample();
      observeGc(gc.takeRecords());
    } finally {
      clearInterval(probe);
      activity.disable();
      gc.disconnect();
    }
    longestBlocking = Math.max(longestBlocking, longestGc);
    process.stderr.write(
      `plugin compile main-thread blocking: ${longestBlocking.toFixed(2)} ms ${JSON.stringify({ longestWall, longestWallCpu, ...longestWallEvents, longestBlockingWindow, longestGc })}\n`,
    );
    assert.ok(service.catalog()[0]?.clientBundle.includes("compiled fixture"));
    results.push({ blockingMs: longestBlocking });
  }
  // Evaluate after both probes so parsing the returned code is not charged to compilation.
  const factory = globalThis.eval(service.catalog()[0]!.clientBundle) as (
    require: (specifier: string) => never,
  ) => { default: () => () => string };
  const result = factory((specifier) => {
    throw new Error(`Unexpected fixture dependency: ${specifier}`);
  }).default()();
  assert.equal(result, "compiled fixture");
} finally {
  await service.stopAllPlugins();
}
process.stdout.write(JSON.stringify(results));
