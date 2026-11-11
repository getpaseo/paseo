import { expect, test } from "vitest";
import {
  EVENT_LOOP_DELAY_RESOLUTION_MS,
  EventLoopDelayMonitor,
  type DelayHistogram,
} from "./event-loop-delay.js";

const MS = 1e6;

/** A histogram like monitorEventLoopDelay's: values are the sampling interval plus lateness. */
class FakeHistogram implements DelayHistogram {
  enabled = false;
  resets = 0;
  samplesNs: number[] = [];

  enable(): boolean {
    this.enabled = true;
    return true;
  }
  disable(): boolean {
    this.enabled = false;
    return true;
  }
  reset(): void {
    this.resets += 1;
    this.samplesNs = [];
  }
  percentile(percentile: number): number {
    if (this.samplesNs.length === 0) return 0;
    const sorted = [...this.samplesNs].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
  get max(): number {
    return this.samplesNs.length === 0 ? 0 : Math.max(...this.samplesNs);
  }
  /** Records samples that ran the given number of ms late. */
  record(lateMs: number[]): void {
    for (const late of lateMs) {
      this.samplesNs.push((EVENT_LOOP_DELAY_RESOLUTION_MS + late) * MS);
    }
  }
}

function startMonitor(): {
  monitor: EventLoopDelayMonitor;
  histogram: FakeHistogram;
  requested: number[];
} {
  const histogram = new FakeHistogram();
  const requested: number[] = [];
  const monitor = new EventLoopDelayMonitor((resolutionMs) => {
    requested.push(resolutionMs);
    return histogram;
  });
  return { monitor, histogram, requested };
}

test("samples every 100 ms instead of every 10 ms", () => {
  const { histogram, requested } = startMonitor();
  expect(requested).toEqual([100]);
  expect(histogram.enabled).toBe(true);
});

test("reports how late samples ran, not the sampling interval", () => {
  const { monitor, histogram } = startMonitor();
  histogram.record([0, 1, 2, 2, 3]);
  expect(monitor.snapshot()).toEqual({ p50Ms: 2, p99Ms: 3, maxMs: 3 });
});

test("a late sample shows up in p99 and max", () => {
  const { monitor, histogram } = startMonitor();
  histogram.record([1, 1, 1, 1, 400]);
  expect(monitor.snapshot()).toEqual({ p50Ms: 1, p99Ms: 400, maxMs: 400 });
});

test("each snapshot covers only the samples since the previous one", () => {
  const { monitor, histogram } = startMonitor();
  histogram.record([250]);
  expect(monitor.snapshot()).toEqual({ p50Ms: 250, p99Ms: 250, maxMs: 250 });
  expect(histogram.resets).toBe(1);
  histogram.record([2]);
  expect(monitor.snapshot()).toEqual({ p50Ms: 2, p99Ms: 2, maxMs: 2 });
});

test("a window without samples reads zero", () => {
  const { monitor } = startMonitor();
  expect(monitor.snapshot()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
});

test("stop disables the histogram", () => {
  const { monitor, histogram } = startMonitor();
  monitor.stop();
  expect(histogram.enabled).toBe(false);
});
