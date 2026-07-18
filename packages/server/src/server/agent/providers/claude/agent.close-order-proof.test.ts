/**
 * Objective evidence harness for #2034.
 *
 * Models @anthropic-ai/claude-agent-sdk Query/ProcessTransport contracts from
 * packages/server/node_modules/@anthropic-ai/claude-agent-sdk/{sdk.mjs,sdk.d.ts}:
 *
 * - interrupt() is a streaming control request that must transport.write()
 * - ProcessTransport.write throws "ProcessTransport is not ready for writing"
 *   when !ready || !processStdin
 * - query.close() starts cleanup() without awaiting; cleanup calls transport.close()
 * - return() awaits the same cleanupPromise (waitForExit capped ~2s)
 *
 * Compares the two Paseo sequences:
 * - upstream/main: close → interrupt → return  (broken)
 * - fixed: interrupt → return → close
 */
import { expect, test } from "vitest";

type CloseOrder = "upstream-close-first" | "fixed-interrupt-first";

function createSdkLikeQuery(options: { waitForExitMs: number }) {
  let ready = true;
  let processStdin: object | null = {};
  let cleanupPromise: Promise<void> | null = null;
  const events: string[] = [];
  const errors: Error[] = [];

  const transportWrite = (label: string) => {
    if (!ready || !processStdin) {
      throw new Error("ProcessTransport is not ready for writing");
    }
    events.push(`write:${label}`);
  };

  const transportClose = () => {
    events.push("transport.close");
    processStdin = null;
    ready = false;
  };

  const performCleanup = async () => {
    events.push("cleanup.start");
    transportClose();
    await new Promise((r) => setTimeout(r, options.waitForExitMs));
    events.push("cleanup.done");
  };

  const cleanup = () => {
    if (!cleanupPromise) cleanupPromise = performCleanup();
    return cleanupPromise;
  };

  return {
    events,
    errors,
    close() {
      events.push("query.close");
      void cleanup(); // real SDK: fire-and-forget
    },
    async interrupt() {
      events.push("query.interrupt");
      try {
        await Promise.resolve(transportWrite("interrupt"));
        events.push("interrupt.ok");
      } catch (error) {
        errors.push(error as Error);
        events.push(`interrupt.err:${(error as Error).message}`);
        throw error;
      }
    },
    async return() {
      events.push("query.return");
      await cleanup();
      events.push("return.done");
    },
  };
}

async function awaitWithTimeoutLike(
  promise: Promise<unknown> | undefined,
  label: string,
  settled: string[],
): Promise<void> {
  if (!promise) return;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
    ]);
    settled.push(`${label}:ok`);
  } catch (error) {
    settled.push(`${label}:err:${(error as Error).message}`);
  }
}

async function runQueryTeardown(order: CloseOrder, query: ReturnType<typeof createSdkLikeQuery>) {
  const settled: string[] = [];
  const startedAt = Date.now();
  if (order === "upstream-close-first") {
    query.close();
    await awaitWithTimeoutLike(query.interrupt(), "close query interrupt", settled);
    await awaitWithTimeoutLike(query.return(), "close query return", settled);
  } else {
    await awaitWithTimeoutLike(query.interrupt(), "close query interrupt", settled);
    await awaitWithTimeoutLike(query.return(), "close query return", settled);
    query.close();
  }
  return { elapsedMs: Date.now() - startedAt, settled };
}

test("SDK write contract: closed transport throws ProcessTransport error", async () => {
  const query = createSdkLikeQuery({ waitForExitMs: 0 });
  query.close();
  await expect(query.interrupt()).rejects.toThrow("ProcessTransport is not ready for writing");
});

test("upstream close-first sequence produces ProcessTransport on interrupt", async () => {
  const query = createSdkLikeQuery({ waitForExitMs: 30 });
  const { settled } = await runQueryTeardown("upstream-close-first", query);
  expect(query.events[0]).toBe("query.close");
  expect(query.events).toContain("transport.close");
  expect(query.errors.map((e) => e.message)).toEqual(["ProcessTransport is not ready for writing"]);
  expect(query.events).not.toContain("write:interrupt");
  expect(settled.some((s) => s.includes("ProcessTransport is not ready for writing"))).toBe(true);
});

test("fixed interrupt-first sequence writes interrupt while transport is ready", async () => {
  const query = createSdkLikeQuery({ waitForExitMs: 30 });
  const { settled } = await runQueryTeardown("fixed-interrupt-first", query);
  expect(query.events[0]).toBe("query.interrupt");
  expect(query.events).toContain("write:interrupt");
  expect(query.events).toContain("interrupt.ok");
  expect(query.errors).toEqual([]);
  expect(query.events.indexOf("query.interrupt")).toBeLessThan(query.events.indexOf("query.close"));
  expect(settled).toContain("close query interrupt:ok");
});

test("upstream path never successfully interrupts after close (issue log root cause)", async () => {
  // Mirrors issue #2034 stack: interrupt → request → transport.write after close.
  const query = createSdkLikeQuery({ waitForExitMs: 10 });
  query.close(); // transport dies first (upstream)
  let thrown: Error | null = null;
  try {
    await query.interrupt();
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown?.message).toBe("ProcessTransport is not ready for writing");
  // cleanup rejects pending with this alternate message if write raced earlier
  expect(thrown?.message).not.toBe("timeout");
});
