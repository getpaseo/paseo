import type { HostBattery } from "@getpaseo/protocol/messages";

import { probeHostBattery, type HostBatteryProbe } from "./host-battery.js";

/**
 * Keeps the host's charge current and tells the caller only when it actually moved.
 *
 * Charge moves slowly, so the sampler is built around not doing work: it ticks once a minute,
 * skips the tick entirely while nobody is connected, stops for good once a probe says the
 * machine has no battery, and reports a change only when the whole-number percent differs from
 * the last one it reported. A machine draining over an hour therefore broadcasts a few dozen
 * times, not a few thousand.
 */

export const HOST_BATTERY_SAMPLE_INTERVAL_MS = 60_000;

/** Consecutive failures tolerated before a probe is treated as a settled "no battery". */
const FAILURE_LIMIT = 3;

export interface HostBatterySamplerOptions {
  onChange: (battery: HostBattery | null) => void;
  hasClients: () => boolean;
  probe?: () => Promise<HostBatteryProbe>;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class HostBatterySampler {
  private readonly options: HostBatterySamplerOptions;
  private readonly probe: () => Promise<HostBatteryProbe>;
  private readonly intervalMs: number;
  private handle: ReturnType<typeof setInterval> | null = null;
  private current: HostBattery | null = null;
  private hasReading = false;
  private settledAbsent = false;
  private consecutiveFailures = 0;
  private inFlight: Promise<void> | null = null;

  constructor(options: HostBatterySamplerOptions) {
    this.options = options;
    this.probe = options.probe ?? probeHostBattery;
    this.intervalMs = options.intervalMs ?? HOST_BATTERY_SAMPLE_INTERVAL_MS;
  }

  /**
   * The last reading, for seeding `server_info` on a fresh connection. `undefined` means no
   * probe has finished yet and is distinct from `null`: a client that is told `null` renders a
   * host with no battery, which would be wrong for a machine we simply have not measured.
   */
  getCurrent(): HostBattery | null | undefined {
    return this.hasReading ? this.current : undefined;
  }

  start(): void {
    if (this.handle) {
      return;
    }
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.handle = setIntervalFn(() => {
      void this.sampleNow();
    }, this.intervalMs);
    // Node holds the event loop open for a bare interval, which would keep a daemon that has
    // finished shutting down alive for up to a minute.
    this.handle.unref?.();
    void this.sampleNow();
  }

  stop(): void {
    if (this.handle) {
      (this.options.clearIntervalFn ?? clearInterval)(this.handle);
      this.handle = null;
    }
  }

  /**
   * Runs a probe unless one is already running. Ticks overlap when a probe outlives the
   * interval — a WMI query under load can — and a second concurrent shell-out would only make
   * that worse, so the in-flight promise is shared rather than queued behind.
   */
  async sampleNow(): Promise<void> {
    if (this.settledAbsent) {
      return;
    }
    if (this.inFlight) {
      return await this.inFlight;
    }
    this.inFlight = this.runProbe().finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  private async runProbe(): Promise<void> {
    // Checked here rather than in `start` so that connecting a client resumes sampling on the
    // next tick without anyone having to restart the sampler.
    if (!this.options.hasClients()) {
      return;
    }
    const result = await this.probe();
    if (result.outcome === "ok") {
      this.consecutiveFailures = 0;
      this.publish(result.battery);
      return;
    }
    if (result.outcome === "absent") {
      this.consecutiveFailures = 0;
      this.settle();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_LIMIT) {
      // Distinguishing "no battery" from "the probe keeps breaking" is not worth an indicator
      // that flickers. After a few failures, treat the host as batteryless and go quiet.
      this.settle();
    }
  }

  private settle(): void {
    this.settledAbsent = true;
    this.stop();
    this.publish(null);
  }

  private publish(next: HostBattery | null): void {
    if (this.hasReading && samePercent(this.current, next)) {
      return;
    }
    this.hasReading = true;
    this.current = next;
    this.options.onChange(next);
  }
}

/** Compared at display precision — a percent the UI would render identically is not a change. */
function samePercent(a: HostBattery | null, b: HostBattery | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.round(a.percent) === Math.round(b.percent);
}
