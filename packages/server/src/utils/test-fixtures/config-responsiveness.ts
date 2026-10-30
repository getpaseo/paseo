import { createHook, executionAsyncResource } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { MessagePort } from "node:worker_threads";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { measureMainThreadWork } from "../../test-utils/main-thread-work.js";
import { readPaseoConfigForEdit } from "../paseo-config-file.js";

// The parent bundles this fixture before launching plain Node, keeping test
// runner callbacks and runtime loader messages outside the measured thread.
// Read the real file once, without warming the config snapshot or schema.
const directory = process.argv[2];
assert.ok(directory, "Config directory is required");
await nextTurn();
let workerMessages = 0;
const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
  process,
  "threadCpuUsage",
);
const callbackStarts = new Map<number, { start: number; cpu: NodeJS.CpuUsage }>();
const spans: { start: number; end: number; cpuMs: number }[] = [];
const currentMicros = () => Number(process.hrtime.bigint() / 1000n);
const activity = createHook({
  before(id) {
    callbackStarts.set(id, { start: currentMicros(), cpu: threadCpuUsage() });
    if (executionAsyncResource() instanceof MessagePort) workerMessages++;
  },
  after(id) {
    const start = callbackStarts.get(id);
    if (!start) return;
    callbackStarts.delete(id);
    const end = currentMicros();
    const cpu = threadCpuUsage(start.cpu);
    if (end - start.start > 8000)
      spans.push({ start: start.start, end, cpuMs: (cpu.user + cpu.system) / 1000 });
  },
});
const profiler = process.argv[3] === "profile" ? new Session() : null;
if (profiler) {
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.setSamplingInterval", { interval: 100 });
  await profiler.post("Profiler.start");
}
await nextTurn();
activity.enable();
const measured = await measureMainThreadWork("project config main-thread work", () =>
  readPaseoConfigForEdit(directory),
);
activity.disable();
process.stderr.write(`Config profiling: ${Boolean(profiler)}\n`);
const profile = profiler ? (await profiler.post("Profiler.stop")).profile : null;
profiler?.disconnect();
if (spans.length > 0) {
  process.stderr.write(
    `Config long callbacks: ${JSON.stringify(spans.map(({ start, end, cpuMs }) => ({ wallMs: (end - start) / 1000, cpuMs })))}\n`,
  );
}
if (profile && spans.length > 0) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const samples = new Map<number, number>();
  let sampleTime = profile.startTime;
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const delta = profile.timeDeltas?.[index] ?? 0;
    sampleTime += delta;
    const overlap = spans.reduce(
      (total, span) =>
        total +
        Math.max(0, Math.min(sampleTime, span.end) - Math.max(sampleTime - delta, span.start)),
      0,
    );
    if (overlap > 0) samples.set(id, (samples.get(id) ?? 0) + overlap);
  }

  const hottest = [...samples]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id, micros]) => {
      const frame = nodes.get(id)!.callFrame;
      const callers: string[] = [];
      let parent = parents.get(id);
      while (parent !== undefined && callers.length < 5) {
        callers.push(nodes.get(parent)!.callFrame.functionName);
        parent = parents.get(parent);
      }
      return {
        function: frame.functionName,
        callers,
        line: frame.lineNumber,
        milliseconds: micros / 1000,
      };
    });
  process.stderr.write(`Config CPU diagnostic: ${JSON.stringify(hottest)}\n`);
}
process.stdout.write(JSON.stringify({ ...measured, workerMessages }));
