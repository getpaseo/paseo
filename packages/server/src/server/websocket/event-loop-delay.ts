import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Sampling interval of the event-loop delay monitor. Every sample is a timer wakeup for the
 * daemon's whole life, so 10 ms meant 100 wakeups a second on an idle daemon. Any stall longer
 * than this interval still delays a sample, so it is recorded.
 */
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 100;

export interface EventLoopDelaySnapshot {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
}

/**
 * Creates a histogram like monitorEventLoopDelay's: each value, in nanoseconds, is the time
 * between two samples, i.e. the resolution plus how late the sample ran.
 */
export type CreateDelayHistogram = (resolutionMs: number) => DelayHistogram;

const createNodeDelayHistogram: CreateDelayHistogram = (resolution) =>
  monitorEventLoopDelay({ resolution });

/**
 * Event-loop delay percentiles for the runtime metrics line and daemon diagnostics. Values are
 * how late each sample ran (the sampling interval subtracted), so an idle loop reads near 0
 * instead of the interval.
 */
export class EventLoopDelayMonitor {
  private readonly histogram: DelayHistogram;

  constructor(createHistogram: CreateDelayHistogram = createNodeDelayHistogram) {
    this.histogram = createHistogram(EVENT_LOOP_DELAY_RESOLUTION_MS);
    this.histogram.enable();
  }

  /** Percentiles since the last snapshot. */
  snapshot(): EventLoopDelaySnapshot {
    const intervalNs = EVENT_LOOP_DELAY_RESOLUTION_MS * 1e6;
    const toMs = (nanoseconds: number): number =>
      Math.round(Math.max(0, nanoseconds - intervalNs) / 1e5) / 10;
    const snapshot = {
      p50Ms: toMs(this.histogram.percentile(50)),
      p99Ms: toMs(this.histogram.percentile(99)),
      maxMs: toMs(this.histogram.max),
    };
    this.histogram.reset();
    return snapshot;
  }

  stop(): void {
    this.histogram.disable();
  }
}
