import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeRequestSnapshot } from "./change-request-source.js";
import {
  ChangeRequestRateLimitError,
  createPerHostChangeRequestPoller,
  parseCliHttpResponse,
  parseRetryAfterMs,
} from "./change-request-poller.js";

const sampleSnapshot: ChangeRequestSnapshot = {
  state: "open",
  headSha: "abc123",
  checksState: "passed",
  checks: [],
  reviewDecision: null,
  activity: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("parseCliHttpResponse", () => {
  it("parses status line, mixed line endings, redirect blocks, and JSON body", () => {
    const raw = [
      "HTTP/1.1 100 Continue\r\n\r\n",
      "HTTP/2.0 200 OK\n",
      "Content-Type: application/json\r\n",
      "X-Next-Page: 2\r\n",
      "Ratelimit-Remaining: 95\r\n",
      "Ratelimit-Reset: 1700000120\r\n",
      "\r\n",
      '{"ok":true}',
    ].join("");
    const parsed = parseCliHttpResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.headers.get("x-next-page")).toBe("2");
    expect(parsed.headers.get("ratelimit-remaining")).toBe("95");
    expect(parsed.body).toBe('{"ok":true}');
  });

  it("returns null status and raw body when headers are absent", () => {
    const parsed = parseCliHttpResponse('{"ok":true}');
    expect(parsed.status).toBeNull();
    expect(parsed.headers.size).toBe(0);
    expect(parsed.body).toBe('{"ok":true}');
  });
});

describe("parseRetryAfterMs", () => {
  it("parses Retry-After seconds and exhausted Ratelimit-Reset headers", () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfterMs(new Map([["retry-after", "45"]]), now)).toBe(now + 45_000);
    expect(
      parseRetryAfterMs(
        new Map([
          ["ratelimit-remaining", "0"],
          ["ratelimit-reset", "1700000060"],
        ]),
        now,
      ),
    ).toBe(1_700_000_060_000);
    expect(
      parseRetryAfterMs(
        new Map([
          ["ratelimit-remaining", "50"],
          ["ratelimit-reset", "1700000060"],
        ]),
        now,
      ),
    ).toBeNull();
  });
});

describe("createPerHostChangeRequestPoller", () => {
  it("bounds concurrent reads per host and drains waiting watches as slots free", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<string, () => void>();
    const poller = createPerHostChangeRequestPoller({
      hostOf: (url) => new URL(url).hostname,
      maxConcurrencyPerHost: 2,
      pollIntervalMs: 20_000,
      async read({ url }) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          resolvers.set(url, resolve);
        });
        active -= 1;
        return sampleSnapshot;
      },
    });
    const received: string[] = [];
    try {
      for (const n of [1, 2, 3]) {
        const url = `https://gitlab.com/org/repo/-/merge_requests/${n}`;
        poller.observe(url, {
          async snapshot() {
            received.push(url);
          },
          error(error) {
            throw error;
          },
        });
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(maxActive).toBe(2);
      expect(resolvers.size).toBe(2);

      resolvers.get("https://gitlab.com/org/repo/-/merge_requests/1")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(maxActive).toBe(2);
      expect(resolvers.has("https://gitlab.com/org/repo/-/merge_requests/3")).toBe(true);

      resolvers.get("https://gitlab.com/org/repo/-/merge_requests/2")?.();
      resolvers.get("https://gitlab.com/org/repo/-/merge_requests/3")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(3);
    } finally {
      poller.dispose();
    }
  });

  it("backs off exponentially on transient errors and resets after a successful poll", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let shouldFail = true;
    const poller = createPerHostChangeRequestPoller({
      hostOf: (url) => new URL(url).hostname,
      pollIntervalMs: 10_000,
      maxErrorBackoffMs: 40_000,
      async read() {
        calls += 1;
        if (shouldFail) throw new Error(`fail ${calls}`);
        return sampleSnapshot;
      },
    });
    const errors: unknown[] = [];
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      poller.observe("https://gitlab.com/org/repo/-/merge_requests/1", {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(calls).toBe(1);
      expect(errors).toHaveLength(1);

      // 1st failure -> 10s backoff
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);

      // 2nd failure -> 20s backoff
      await vi.advanceTimersByTimeAsync(19_999);
      expect(calls).toBe(2);
      shouldFail = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);
      expect(snapshots).toHaveLength(1);

      // Reset to 10s base interval after success
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(4);
    } finally {
      poller.dispose();
    }
  });

  it("pauses all watches on a rate-limited host until resetAt and fast-fails new observers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let calls = 0;
    const poller = createPerHostChangeRequestPoller({
      hostOf: (url) => new URL(url).hostname,
      pollIntervalMs: 10_000,
      async read() {
        calls += 1;
        if (calls === 1) {
          throw new ChangeRequestRateLimitError({
            host: "gitlab.com",
            resetAtMs: Date.now() + 60_000,
          });
        }
        return sampleSnapshot;
      },
    });
    const errors1: unknown[] = [];
    const errors2: unknown[] = [];
    const snapshots2: ChangeRequestSnapshot[] = [];
    try {
      poller.observe("https://gitlab.com/org/repo/-/merge_requests/1", {
        async snapshot() {},
        error(err) {
          errors1.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(calls).toBe(1);
      expect(errors1[0]).toBeInstanceOf(ChangeRequestRateLimitError);

      poller.observe("https://gitlab.com/org/repo/-/merge_requests/2", {
        async snapshot(s) {
          snapshots2.push(s);
        },
        error(err) {
          errors2.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(errors2[0]).toBeInstanceOf(ChangeRequestRateLimitError);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(3);
      expect(snapshots2).toHaveLength(1);
    } finally {
      poller.dispose();
    }
  });
});
