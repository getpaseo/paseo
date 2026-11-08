import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** Resolution while the loop is doing work: catches any stall longer than 100 ms. */
export const BUSY_EVENT_LOOP_DELAY_RESOLUTION_MS = 100;
/** Resolution while the daemon is idle, when there is nothing to stall. */
export const IDLE_EVENT_LOOP_DELAY_RESOLUTION_MS = 1000;
// A window is idle when the loop spent under 0.5 % of it running (150 ms in a 30 s window).
const IDLE_LOOP_UTILIZATION = 0.005;

export interface EventLoopDelaySnapshot {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

interface DelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
}

interface LoopUtilization {
  idle: number;
  active: number;
}

export interface EventLoopDelaySources {
  /**
   * A histogram like monitorEventLoopDelay's: each value is the time between two samples, i.e. the
   * resolution plus how late the sample ran (~100 ms for an idle loop at 100 ms).
   */
  createMonitor(resolutionMs: number): DelayHistogram;
  /** Cumulative loop idle/active milliseconds, as performance.eventLoopUtilization() reports. */
  loopUtilization(): LoopUtilization;
}

const defaultSources: EventLoopDelaySources = {
  createMonitor: (resolution) => monitorEventLoopDelay({ resolution }),
  loopUtilization: () => performance.eventLoopUtilization(),
};

/**
 * Event-loop delay percentiles for the runtime metrics line. The underlying monitor arms a timer
 * every `resolution` ms for the daemon's whole life, which is most of an idle daemon's wakeups.
 * So it samples every 100 ms while the loop is busy and every 1000 ms after a window in which the
 * loop was idle. A stall makes its window busy, so the next window is sampled finely again.
 * Values are the lateness of each sample (the sampling interval subtracted), so they mean the same
 * at either resolution and an idle loop reads near 0.
 */
export class AdaptiveEventLoopDelayMonitor {
  private monitor: DelayHistogram;
  private resolution = BUSY_EVENT_LOOP_DELAY_RESOLUTION_MS;
  private windowStart: LoopUtilization;

  constructor(private readonly sources: EventLoopDelaySources = defaultSources) {
    this.monitor = sources.createMonitor(this.resolution);
    this.monitor.enable();
    this.windowStart = sources.loopUtilization();
  }

  get resolutionMs(): number {
    return this.resolution;
  }

  /** Percentiles since the last snapshot; then picks the resolution for the next window. */
  snapshot(): EventLoopDelaySnapshot {
    const intervalNs = this.resolution * 1e6;
    const toMs = (nanoseconds: number): number =>
      Math.round(Math.max(0, nanoseconds - intervalNs) / 1e5) / 10;
    const snapshot = {
      p50Ms: toMs(this.monitor.percentile(50)),
      p99Ms: toMs(this.monitor.percentile(99)),
      maxMs: toMs(this.monitor.max),
    };
    const next = this.windowWasIdle()
      ? IDLE_EVENT_LOOP_DELAY_RESOLUTION_MS
      : BUSY_EVENT_LOOP_DELAY_RESOLUTION_MS;
    if (next === this.resolution) {
      this.monitor.reset();
    } else {
      this.monitor.disable();
      this.resolution = next;
      this.monitor = this.sources.createMonitor(next);
      this.monitor.enable();
    }
    this.windowStart = this.sources.loopUtilization();
    return snapshot;
  }

  stop(): void {
    this.monitor.disable();
  }

  private windowWasIdle(): boolean {
    const loop = this.sources.loopUtilization();
    const idle = loop.idle - this.windowStart.idle;
    const active = loop.active - this.windowStart.active;
    // Nothing measured (no time passed): keep sampling finely.
    if (idle + active <= 0) return false;
    return active / (idle + active) < IDLE_LOOP_UTILIZATION;
  }
}
