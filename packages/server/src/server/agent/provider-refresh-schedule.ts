import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";

export const PROVIDER_BACKGROUND_REFRESH_INTERVAL_MS = 30 * 60_000;

/** Clock and one-shot timers the schedule runs on; tests drive a fake. */
export interface ProviderRefreshTimers {
  now(): number;
  /** Runs `run` once after `delayMs`; the returned function cancels it. */
  schedule(run: () => void, delayMs: number): () => void;
}

export const systemProviderRefreshTimers: ProviderRefreshTimers = {
  now: () => Date.now(),
  schedule(run, delayMs) {
    const timer = setTimeout(run, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface ProviderRefreshScheduleOptions {
  intervalMs: number;
  timers: ProviderRefreshTimers;
  refresh(provider: AgentProvider): Promise<void>;
  logger: Logger;
}

/**
 * Keeps each provider refreshed about once per interval without bursts. One timer ticks
 * `interval / providers` apart and each tick refreshes at most the provider refreshed longest
 * ago, so refreshes spread across the interval and a recent refresh pushes its provider back.
 */
export class ProviderRefreshSchedule {
  private readonly refreshedAt = new Map<AgentProvider, number>();
  private cancelTick: (() => void) | null = null;
  private refreshing = false;
  private disposed = false;

  constructor(private readonly options: ProviderRefreshScheduleOptions) {}

  /** The providers to keep fresh. A provider seen for the first time counts as refreshed now. */
  setProviders(providers: readonly AgentProvider[]): void {
    if (this.disposed) return;
    const next = new Set(providers);
    for (const provider of this.refreshedAt.keys()) {
      if (!next.has(provider)) this.refreshedAt.delete(provider);
    }
    const now = this.options.timers.now();
    for (const provider of next) {
      if (!this.refreshedAt.has(provider)) this.refreshedAt.set(provider, now);
    }
    this.scheduleTick();
  }

  /** A refresh of these providers started now, wherever it came from. */
  recordRefresh(providers: readonly AgentProvider[]): void {
    const now = this.options.timers.now();
    for (const provider of providers) {
      if (this.refreshedAt.has(provider)) this.refreshedAt.set(provider, now);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.refreshedAt.clear();
  }

  private tickMs(): number {
    return this.options.intervalMs / this.refreshedAt.size;
  }

  private scheduleTick(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    // The tick after a running refresh is scheduled when it settles.
    if (this.disposed || this.refreshing || this.refreshedAt.size === 0) return;
    this.cancelTick = this.options.timers.schedule(() => void this.tick(), this.tickMs());
  }

  private async tick(): Promise<void> {
    this.cancelTick = null;
    const provider = this.dueProvider();
    if (!provider) {
      this.scheduleTick();
      return;
    }
    this.recordRefresh([provider]);
    this.refreshing = true;
    try {
      await this.options.refresh(provider);
    } catch (error) {
      this.options.logger.warn({ err: error, provider }, "Background provider refresh failed");
    } finally {
      this.refreshing = false;
      this.scheduleTick();
    }
  }

  private dueProvider(): AgentProvider | undefined {
    const now = this.options.timers.now();
    // Half a tick of slack: a provider refreshed on a tick is due exactly one interval of ticks
    // later, and timer jitter must not push it to the slot after.
    const dueBefore = now - this.options.intervalMs + this.tickMs() / 2;
    let oldest: { provider: AgentProvider; refreshedAt: number } | undefined;
    for (const [provider, refreshedAt] of this.refreshedAt) {
      if (refreshedAt > dueBefore) continue;
      if (!oldest || refreshedAt < oldest.refreshedAt) oldest = { provider, refreshedAt };
    }
    return oldest?.provider;
  }
}
