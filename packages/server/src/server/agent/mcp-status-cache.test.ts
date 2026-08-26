import { describe, expect, test, vi } from "vitest";
import { McpStatusCache } from "./mcp-status-cache.js";
import type { AgentMcpReport } from "./agent-sdk-types.js";

function report(name: string): AgentMcpReport {
  return { servers: [{ name, status: "connected" }], source: "live" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("McpStatusCache", () => {
  test("serves a second read from cache instead of calling the provider again", async () => {
    const load = vi.fn(async () => report("a"));
    const cache = new McpStatusCache();

    expect((await cache.read("agent-1", false, load)).report).toEqual(report("a"));
    expect((await cache.read("agent-1", false, load)).report).toEqual(report("a"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a cache hit keeps the original fetch time rather than claiming it is current", async () => {
    let now = 1_000_000;
    const cache = new McpStatusCache(30_000, () => now);

    const first = await cache.read("agent-1", false, async () => report("a"));
    now += 29_000;
    const hit = await cache.read("agent-1", false, async () => report("a"));

    // A 29-second-old report that stamped itself with the current time would tell the
    // user it was fetched just now.
    expect(hit.fetchedAt).toBe(first.fetchedAt);

    now += 2_000;
    const refetched = await cache.read("agent-1", false, async () => report("a"));
    expect(refetched.fetchedAt).not.toBe(first.fetchedAt);
  });

  test("coalesces concurrent reads into one provider call", async () => {
    const gate = deferred<AgentMcpReport>();
    const load = vi.fn(() => gate.promise);
    const cache = new McpStatusCache();

    // Two clients with the panel open at once must not each pay for a 3.5s Codex fetch.
    const both = Promise.all([
      cache.read("agent-1", false, load),
      cache.read("agent-1", false, load),
    ]);
    gate.resolve(report("a"));

    expect((await both).map((r) => r.report)).toEqual([report("a"), report("a")]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("keeps agents apart", async () => {
    const load = vi.fn(async () => report("a"));
    const cache = new McpStatusCache();

    await cache.read("agent-1", false, load);
    await cache.read("agent-2", false, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("refetches once the entry ages out", async () => {
    let now = 1_000;
    const load = vi.fn(async () => report("a"));
    const cache = new McpStatusCache(30_000, () => now);

    await cache.read("agent-1", false, load);
    now += 29_999;
    await cache.read("agent-1", false, load);
    expect(load).toHaveBeenCalledTimes(1);

    now += 2;
    await cache.read("agent-1", false, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("force bypasses a fresh entry, because refresh has to mean refresh", async () => {
    const load = vi.fn(async () => report("a"));
    const cache = new McpStatusCache();

    await cache.read("agent-1", false, load);
    await cache.read("agent-1", true, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("force still joins an in-flight call rather than starting a second one", async () => {
    const gate = deferred<AgentMcpReport>();
    const load = vi.fn(() => gate.promise);
    const cache = new McpStatusCache();

    const both = Promise.all([
      cache.read("agent-1", false, load),
      cache.read("agent-1", true, load),
    ]);
    gate.resolve(report("a"));

    await both;
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("does not cache a failure, and does not wedge the agent behind it", async () => {
    const cache = new McpStatusCache();
    const failing = vi.fn(async () => {
      throw new Error("provider exploded");
    });

    await expect(cache.read("agent-1", false, failing)).rejects.toThrow("provider exploded");
    // The in-flight entry has to be cleared or every later read would await a rejected
    // promise forever.
    expect((await cache.read("agent-1", false, async () => report("a"))).report).toEqual(
      report("a"),
    );
  });

  test("invalidate drops the entry so a restarted runtime is re-read", async () => {
    const load = vi.fn(async () => report("a"));
    const cache = new McpStatusCache();

    await cache.read("agent-1", false, load);
    cache.invalidate("agent-1");
    await cache.read("agent-1", false, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
