import type { ChangeRequestSnapshot, ChangeRequestSource } from "./change-request-source.js";

const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_POLL_INTERVAL_MS = 20_000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 300_000;
const DEFAULT_MAX_CONCURRENCY_PER_HOST = 2;
const MIN_RATE_LIMIT_PAUSE_MS = 1_000;
const MAX_RATE_LIMIT_PAUSE_MS = 15 * 60_000;

export interface ParsedCliHttpResponse {
  status: number | null;
  headers: Map<string, string>;
  body: string;
}

const HTTP_STATUS_PREFIX = /^HTTP\/\d(?:\.\d)?\s+(\d{3})[^\r\n]*\r?\n/;
const HEADER_BODY_SEPARATOR = /\r?\n\r?\n/;

/**
 * Parse output from CLI API commands invoked with `-i` / `--include`.
 * Consumes multiple leading HTTP response blocks (e.g. `100 Continue` or
 * redirect headers) and returns the final status code, lowercased headers,
 * and response body. Returns `status: null` when no HTTP header block is
 * present.
 */
export function parseCliHttpResponse(raw: string): ParsedCliHttpResponse {
  let remaining = raw.trimStart();
  let status: number | null = null;
  let headers = new Map<string, string>();

  while (true) {
    const statusMatch = HTTP_STATUS_PREFIX.exec(remaining);
    if (!statusMatch) {
      break;
    }
    const separatorMatch = HEADER_BODY_SEPARATOR.exec(remaining);
    if (!separatorMatch) {
      status = Number(statusMatch[1]);
      headers = parseHeaderLines(remaining.slice(statusMatch[0].length));
      remaining = "";
      break;
    }
    status = Number(statusMatch[1]);
    const headerBlock = remaining.slice(statusMatch[0].length, separatorMatch.index);
    headers = parseHeaderLines(headerBlock);
    remaining = remaining.slice(separatorMatch.index + separatorMatch[0].length);
  }

  return { status, headers, body: remaining.trim() };
}

function parseHeaderLines(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${value}` : value);
  }
  return headers;
}

function clampPauseUntil(targetMs: number, nowMs: number): number {
  return Math.min(
    Math.max(targetMs, nowMs + MIN_RATE_LIMIT_PAUSE_MS),
    nowMs + MAX_RATE_LIMIT_PAUSE_MS,
  );
}

/**
 * Extract the timestamp (epoch ms) until which a host should pause polling
 * based on `Retry-After` or exhausted `Ratelimit-Remaining` / `Ratelimit-Reset`
 * headers. Returns null when no pause is signaled.
 */
export function parseRetryAfterMs(
  headers: ReadonlyMap<string, string>,
  nowMs: number,
  options: { forceOnMissing?: boolean; defaultPauseMs?: number } = {},
): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampPauseUntil(nowMs + Math.ceil(seconds * 1_000), nowMs);
    }
    const parsedDate = Date.parse(retryAfter);
    if (Number.isFinite(parsedDate)) {
      return clampPauseUntil(parsedDate, nowMs);
    }
  }

  const remainingRaw = headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining");
  const resetRaw = headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset");
  const remaining = remainingRaw !== undefined ? Number(remainingRaw) : Number.NaN;
  const resetSec = resetRaw !== undefined ? Number(resetRaw) : Number.NaN;
  if (
    (options.forceOnMissing || (Number.isFinite(remaining) && remaining <= 1)) &&
    Number.isFinite(resetSec) &&
    resetSec > 0
  ) {
    return clampPauseUntil(resetSec * 1_000, nowMs);
  }

  if (options.forceOnMissing) {
    return clampPauseUntil(nowMs + (options.defaultPauseMs ?? 60_000), nowMs);
  }
  return null;
}

export class ChangeRequestRateLimitError extends Error {
  readonly host: string;
  readonly resetAtMs: number;

  constructor(params: { host: string; resetAtMs: number; message?: string }) {
    super(
      params.message ??
        `Change request polling for ${params.host} is rate-limited until ${new Date(params.resetAtMs).toISOString()}`,
    );
    this.name = "ChangeRequestRateLimitError";
    this.host = params.host;
    this.resetAtMs = params.resetAtMs;
  }
}

export interface PerHostReadContext {
  url: string;
  host: string;
  knownActivity(): ReadonlySet<string> | undefined;
  isObserved(): boolean;
  assertHostAvailable(): void;
  pauseHost(untilMs: number): void;
}

export interface PerHostChangeRequestPollerOptions {
  hostOf(url: string): string;
  read(context: PerHostReadContext): Promise<ChangeRequestSnapshot>;
  now?: () => number;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  maxErrorBackoffMs?: number;
  maxConcurrencyPerHost?: number;
  onError?(error: unknown, host: string): void;
}

interface WatchedEntry {
  url: string;
  host: string;
  callbacks: Parameters<ChangeRequestSource["observe"]>[1];
  nextDueAt: number;
  consecutiveErrors: number;
  inFlight: boolean;
}

export interface PerHostChangeRequestPoller {
  observe: ChangeRequestSource["observe"];
  dispose(): void;
}

/**
 * Bounded per-host polling loop shared by REST-backed forge watch adapters.
 * Limits concurrent reads per host, applies exponential backoff on transient
 * failures, and pauses all watches for a host when rate-limited.
 */
export function createPerHostChangeRequestPoller(
  options: PerHostChangeRequestPollerOptions,
): PerHostChangeRequestPoller {
  const now = options.now ?? Date.now;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxErrorBackoffMs = options.maxErrorBackoffMs ?? DEFAULT_MAX_ERROR_BACKOFF_MS;
  const maxConcurrencyPerHost = options.maxConcurrencyPerHost ?? DEFAULT_MAX_CONCURRENCY_PER_HOST;

  const watches = new Map<string, WatchedEntry>();
  const inFlightByHost = new Map<string, number>();
  const pausedUntilByHost = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function pauseHost(host: string, untilMs: number): void {
    const current = pausedUntilByHost.get(host) ?? 0;
    if (untilMs > current) {
      pausedUntilByHost.set(host, untilMs);
    }
  }

  function hostPauseUntil(host: string, nowMs: number): number {
    const until = pausedUntilByHost.get(host) ?? 0;
    if (until <= nowMs) {
      pausedUntilByHost.delete(host);
      return 0;
    }
    return until;
  }

  function armTimer(): void {
    clearTimer();
    if (disposed || watches.size === 0) return;

    const nowMs = now();
    let earliestDue = Number.POSITIVE_INFINITY;
    for (const watch of watches.values()) {
      if (watch.inFlight) continue;
      if ((inFlightByHost.get(watch.host) ?? 0) >= maxConcurrencyPerHost) continue;
      const dueAt = Math.max(watch.nextDueAt, hostPauseUntil(watch.host, nowMs));
      if (dueAt < earliestDue) {
        earliestDue = dueAt;
      }
    }
    if (!Number.isFinite(earliestDue)) return;

    const delay = Math.max(0, earliestDue - nowMs);
    timer = setTimeout(() => {
      timer = null;
      drainDueWatches();
    }, delay);
    timer.unref();
  }

  function drainDueWatches(): void {
    if (disposed) return;
    const nowMs = now();
    for (const watch of watches.values()) {
      if (watch.inFlight) continue;
      const inFlightCount = inFlightByHost.get(watch.host) ?? 0;
      if (inFlightCount >= maxConcurrencyPerHost) continue;
      const dueAt = Math.max(watch.nextDueAt, hostPauseUntil(watch.host, nowMs));
      if (dueAt > nowMs) continue;
      startPoll(watch);
    }
    armTimer();
  }

  function startPoll(watch: WatchedEntry): void {
    watch.inFlight = true;
    inFlightByHost.set(watch.host, (inFlightByHost.get(watch.host) ?? 0) + 1);
    const isObserved = () => !disposed && watches.get(watch.url) === watch;

    void (async () => {
      try {
        const snapshot = await options.read({
          url: watch.url,
          host: watch.host,
          knownActivity: () => watch.callbacks.knownActivity?.(),
          isObserved,
          assertHostAvailable() {
            const nowMs = now();
            const resetAtMs = hostPauseUntil(watch.host, nowMs);
            if (resetAtMs > nowMs) {
              throw new ChangeRequestRateLimitError({ host: watch.host, resetAtMs });
            }
          },
          pauseHost: (untilMs) => pauseHost(watch.host, untilMs),
        });
        if (!isObserved()) return;
        watch.consecutiveErrors = 0;
        await watch.callbacks.snapshot(snapshot);
        if (!isObserved()) return;
        const nowMs = now();
        watch.nextDueAt = Math.max(nowMs + pollIntervalMs, hostPauseUntil(watch.host, nowMs));
      } catch (error) {
        if (!isObserved()) return;
        options.onError?.(error, watch.host);
        const nowMs = now();
        if (error instanceof ChangeRequestRateLimitError) {
          pauseHost(watch.host, error.resetAtMs);
          watch.nextDueAt = Math.max(nowMs + pollIntervalMs, error.resetAtMs);
        } else {
          watch.consecutiveErrors += 1;
          const backoff = Math.min(
            pollIntervalMs * 2 ** (watch.consecutiveErrors - 1),
            maxErrorBackoffMs,
          );
          watch.nextDueAt = nowMs + backoff;
        }
        watch.callbacks.error(error);
      } finally {
        watch.inFlight = false;
        const remaining = (inFlightByHost.get(watch.host) ?? 1) - 1;
        if (remaining > 0) inFlightByHost.set(watch.host, remaining);
        else inFlightByHost.delete(watch.host);
        if (!disposed) {
          // Immediately admit any queued due watch on this host, then re-arm timer.
          drainDueWatches();
        }
      }
    })();
  }

  return {
    observe(url, callbacks) {
      if (disposed) {
        queueMicrotask(() => callbacks.error(new Error("Change request poller is disposed")));
        return () => {};
      }
      const host = options.hostOf(url);
      const nowMs = now();
      const watch: WatchedEntry = {
        url,
        host,
        callbacks,
        nextDueAt: nowMs + initialDelayMs,
        consecutiveErrors: 0,
        inFlight: false,
      };
      watches.set(url, watch);
      const pauseUntil = hostPauseUntil(host, nowMs);
      if (pauseUntil > nowMs) {
        queueMicrotask(() => {
          if (!disposed && watches.get(url) === watch) {
            callbacks.error(new ChangeRequestRateLimitError({ host, resetAtMs: pauseUntil }));
          }
        });
      }
      armTimer();
      return () => {
        if (watches.get(url) === watch) {
          watches.delete(url);
          armTimer();
        }
      };
    },

    dispose() {
      disposed = true;
      clearTimer();
      watches.clear();
      inFlightByHost.clear();
      pausedUntilByHost.clear();
    },
  };
}
