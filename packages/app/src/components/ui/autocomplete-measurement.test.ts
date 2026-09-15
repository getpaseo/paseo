import { expect, it } from "vitest";
import {
  createMeasurementLoop,
  type FrameScheduler,
  type Rect,
  type RelativeAnchorRect,
} from "./autocomplete-measurement";

const ANCHOR: Rect = { x: 40, y: 200, width: 320, height: 24 };
const HOST: Rect = { x: 10, y: 50, width: 400, height: 700 };
const RELATIVE: RelativeAnchorRect = { x: 30, y: 150, width: 320, hostHeight: 700 };

/** A frame queue the test advances by hand, so nothing depends on real timing. */
function frameQueue() {
  const queued = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: FrameScheduler = {
    request(callback) {
      const handle = nextHandle++;
      queued.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      queued.delete(handle);
    },
  };
  return {
    scheduler,
    pending: () => queued.size,
    /** Run every callback queued right now; ones queued during the flush wait for the next. */
    async flush() {
      const due = [...queued.entries()];
      queued.clear();
      for (const [, callback] of due) callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/**
 * Hands out one scripted `[anchor, host]` pair per call and records how often it was asked.
 * The last entry repeats, so a test only scripts the frames it cares about.
 */
function scriptedMeasure(script: ReadonlyArray<readonly [Rect, Rect | null]>) {
  const calls: Array<readonly [Rect, Rect | null]> = [];
  return {
    calls,
    measure(): Promise<readonly [Rect, Rect | null]> {
      const result = script[Math.min(calls.length, script.length - 1)];
      calls.push(result);
      return Promise.resolve(result);
    },
  };
}

function recorder() {
  const measured: RelativeAnchorRect[] = [];
  return { measured, onMeasured: (rect: RelativeAnchorRect) => void measured.push(rect) };
}

it("keeps measuring while the portal host is not registered yet, then reports the anchor", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const measure = scriptedMeasure([
    [ANCHOR, null],
    [ANCHOR, null],
    [ANCHOR, HOST],
  ]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();

  expect(seen.measured).toEqual([]);
  await frames.flush();
  await frames.flush();

  expect(seen.measured).toEqual([RELATIVE]);
  expect(measure.calls).toHaveLength(3);
});

/**
 * A host that answers with zero height is the same non-answer as no host at all: positioning
 * against it puts the popover offscreen. Modelling the missing host only as `null` would let the
 * height check be deleted with every test still green.
 */
it("keeps measuring while the portal host has no height yet", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const measure = scriptedMeasure([
    [ANCHOR, { ...HOST, height: 0 }],
    [ANCHOR, HOST],
  ]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();

  expect(seen.measured).toEqual([]);
  await frames.flush();

  expect(seen.measured).toEqual([RELATIVE]);
});

it("keeps measuring while the anchor has no width yet", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const measure = scriptedMeasure([
    [{ ...ANCHOR, width: 0 }, HOST],
    [ANCHOR, HOST],
  ]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();

  expect(seen.measured).toEqual([]);
  await frames.flush();

  expect(seen.measured).toEqual([RELATIVE]);
});

/**
 * The component measures twice per effect run, immediately and on the next frame, so the two
 * completions overlap. A retry queued by the unusable one must not survive the usable one:
 * it would measure and re-render again after the popover is already placed.
 */
it("cancels a retry queued by an earlier unusable measurement once geometry is usable", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const seen = recorder();
  const unusable = scriptedMeasure([[ANCHOR, null]]);
  const usable = scriptedMeasure([[ANCHOR, HOST]]);

  loop.reset();
  loop.run({ measure: unusable.measure, onMeasured: seen.onMeasured });
  loop.run({ measure: usable.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  await Promise.resolve();

  expect(seen.measured).toEqual([RELATIVE]);
  expect(frames.pending()).toBe(0);

  await frames.flush();
  expect(unusable.calls).toHaveLength(1);
  expect(seen.measured).toEqual([RELATIVE]);
});

it("does not let an unusable measurement that lands after a usable one restart the retries", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const seen = recorder();
  const usable = scriptedMeasure([[ANCHOR, HOST]]);
  const late = scriptedMeasure([[ANCHOR, null]]);

  loop.reset();
  loop.run({ measure: usable.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  expect(seen.measured).toEqual([RELATIVE]);

  loop.run({ measure: late.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();

  expect(frames.pending()).toBe(0);
  expect(late.calls).toHaveLength(1);
});

/**
 * Both measurements the component starts per effect run can come back unusable. Each queuing its
 * own frame would leave the first handle unreferenced, so a later stop cancels only the last one
 * and a retry survives the cleanup that was supposed to end it.
 */
it("queues one retry frame even when two unusable measurements land together", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const seen = recorder();
  const first = scriptedMeasure([[ANCHOR, null]]);
  const second = scriptedMeasure([[ANCHOR, null]]);

  loop.reset();
  loop.run({ measure: first.measure, onMeasured: seen.onMeasured });
  loop.run({ measure: second.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  await Promise.resolve();

  expect(frames.pending()).toBe(1);

  loop.stop();
  expect(frames.pending()).toBe(0);

  await frames.flush();
  expect(first.calls).toHaveLength(1);
  expect(second.calls).toHaveLength(1);
});

/** Stop means stop: a measurement started again without a reset gets one attempt, not a sequence. */
it("does not retry a run that starts after a stop", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const measure = scriptedMeasure([[ANCHOR, null]]);
  const seen = recorder();

  loop.reset();
  loop.stop();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();

  expect(frames.pending()).toBe(0);
  expect(measure.calls).toHaveLength(1);
});

/** The budget is what stops a permanently unlaid-out anchor from measuring every frame forever. */
it("stops after the retry budget is spent", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 3);
  const measure = scriptedMeasure([[ANCHOR, null]]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  for (let frame = 0; frame < 6; frame += 1) await frames.flush();

  expect(measure.calls).toHaveLength(1 + 3);
  expect(frames.pending()).toBe(0);
  expect(seen.measured).toEqual([]);
});

it("drops a completion from before a reset and refills the budget", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const stale = scriptedMeasure([[ANCHOR, HOST]]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: stale.measure, onMeasured: seen.onMeasured });
  loop.reset();
  await Promise.resolve();

  expect(seen.measured).toEqual([]);

  const fresh = scriptedMeasure([
    [ANCHOR, null],
    [ANCHOR, HOST],
  ]);
  loop.run({ measure: fresh.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  await frames.flush();

  expect(seen.measured).toEqual([RELATIVE]);
});

it("stop cancels the queued retry and refuses to queue another", async () => {
  const frames = frameQueue();
  const loop = createMeasurementLoop(frames.scheduler, 12);
  const measure = scriptedMeasure([[ANCHOR, null]]);
  const seen = recorder();

  loop.reset();
  loop.run({ measure: measure.measure, onMeasured: seen.onMeasured });
  await Promise.resolve();
  expect(frames.pending()).toBe(1);

  loop.stop();
  expect(frames.pending()).toBe(0);

  await frames.flush();
  expect(measure.calls).toHaveLength(1);
});
