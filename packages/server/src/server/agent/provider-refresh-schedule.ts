import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";

export const PROVIDER_BACKGROUND_REFRESH_INTERVAL_MS = 30 * 60_000;
/** Timers may fire a little early; a provider refreshed on a tick is still due on its next slot. */
const TIMER_SLACK_MS = 1_000;

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
 * `interval / providers` apart and each tick starts at most one refresh: the provider refreshed
 * longest ago, if that was an interval ago and it has no background refresh running. Ticks do not
 * wait for refreshes, so a slow provider never delays the others.
 */
export class ProviderRefreshSchedule {
  private readonly refreshedAt = new Map<AgentProvider, number>();
  private readonly running = new Set<AgentProvider>();
  private cancelTick: (() => void) | null = null;
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
    this.running.clear();
  }

  private tickMs(): number {
    return this.options.intervalMs / this.refreshedAt.size;
  }

  private scheduleTick(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    if (this.disposed || this.refreshedAt.size === 0) return;
    this.cancelTick = this.options.timers.schedule(() => this.tick(), this.tickMs());
  }

  private tick(): void {
    this.cancelTick = null;
    this.scheduleTick();
    const provider = this.dueProvider();
    if (provider) void this.run(provider);
  }

  private async run(provider: AgentProvider): Promise<void> {
    this.recordRefresh([provider]);
    this.running.add(provider);
    try {
      await this.options.refresh(provider);
    } catch (error) {
      this.options.logger.warn({ err: error, provider }, "Background provider refresh failed");
    } finally {
      this.running.delete(provider);
    }
  }

  private dueProvider(): AgentProvider | undefined {
    const dueBefore = this.options.timers.now() - this.options.intervalMs + TIMER_SLACK_MS;
    let oldest: { provider: AgentProvider; refreshedAt: number } | undefined;
    for (const [provider, refreshedAt] of this.refreshedAt) {
      if (refreshedAt > dueBefore || this.running.has(provider)) continue;
      if (!oldest || refreshedAt < oldest.refreshedAt) oldest = { provider, refreshedAt };
    }
    return oldest?.provider;
  }
}
