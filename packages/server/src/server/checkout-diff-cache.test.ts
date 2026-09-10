import { expect, test } from "vitest";
import { CheckoutDiffCache } from "@server/server/checkout-diff-cache.js";

function createSequencedLoader<T>(first: Promise<T>, second: Promise<T>) {
  let calls = 0;
  return {
    load: () => (++calls === 1 ? first : second),
    get calls() {
      return calls;
    },
  };
}

async function fillCompletedCache(cache: CheckoutDiffCache) {
  for (let i = 0; i < 70; i++) {
    await cache.read({
      cwd: String(i),
      compare: { mode: "base" },
      load: async () => ({ diff: "" }),
    });
  }
}

test("forced reads after a mutation share a fresh build after the active build finishes", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const first = Promise.withResolvers<{ diff: string }>();
  const second = Promise.withResolvers<{ diff: string }>();
  const loader = createSequencedLoader(first.promise, second.promise);
  const { load } = loader;
  const pending = cache.read({ cwd: "repo", compare: { mode: "base" }, load });
  await Promise.resolve();
  const options = { force: true, reason: "repository-mutation" };
  const fresh = cache.read({ cwd: "repo", compare: { mode: "base" }, ...options, load });
  const another = cache.read({ cwd: "repo", compare: { mode: "base" }, ...options, load });
  expect(loader.calls).toBe(1);
  first.resolve({ diff: "before-mutation" });
  expect(await pending).toEqual({ diff: "before-mutation" });
  await Promise.resolve();
  await Promise.resolve();
  expect(loader.calls).toBe(2);
  second.resolve({ diff: "after-mutation" });
  expect(await fresh).toEqual({ diff: "after-mutation" });
  expect(await another).toEqual({ diff: "after-mutation" });
  expect(await cache.read({ cwd: "repo", compare: { mode: "base" }, load })).toEqual({
    diff: "after-mutation",
  });
  expect(loader.calls).toBe(2);
});

test("reads after invalidation wait for fresh work without overlapping the original read", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const first = Promise.withResolvers<{ diff: string }>();
  const second = Promise.withResolvers<{ diff: string }>();
  const loader = createSequencedLoader(first.promise, second.promise);
  const { load } = loader;
  const read = () => cache.read({ cwd: "repo", compare: { mode: "base" }, load });
  const pending = read();
  await Promise.resolve();
  cache.invalidate("repo", "base");
  cache.invalidate("repo", "base");
  const fresh = read();
  const another = read();
  expect(loader.calls).toBe(1);
  first.resolve({ diff: "old" });
  expect(await pending).toEqual({ diff: "old" });
  await Promise.resolve();
  await Promise.resolve();
  expect(loader.calls).toBe(2);
  second.resolve({ diff: "new" });
  expect(await fresh).toEqual({ diff: "new" });
  expect(await another).toEqual({ diff: "new" });
  expect(await read()).toEqual({ diff: "new" });
  expect(loader.calls).toBe(2);
});

test("edits during a read do not delay its caller or cache its outdated snapshot", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const deferred = Promise.withResolvers<{ diff: string }>();
  let calls = 0;
  const load = () => {
    calls += 1;
    return deferred.promise;
  };
  const pending = cache.read({ cwd: "repo", compare: { mode: "uncommitted" }, load });
  await Promise.resolve();
  cache.invalidate("repo", "uncommitted");
  deferred.resolve({ diff: "snapshot" });
  expect(await pending).toEqual({ diff: "snapshot" });
  expect(calls).toBe(1);
  expect(
    await cache.read({
      cwd: "repo",
      compare: { mode: "uncommitted" },
      load: async () => ({ diff: "fresh" }),
    }),
  ).toEqual({ diff: "fresh" });
});

test("active reads survive completed-payload eviction and failed reads can retry", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const deferred = Promise.withResolvers<{ diff: string }>();
  const load = () => deferred.promise;
  const first = cache.read({ cwd: "active", compare: { mode: "uncommitted" }, load });
  const rejected = expect(first).rejects.toThrow("read failed");
  await fillCompletedCache(cache);
  expect(cache.read({ cwd: "active", compare: { mode: "uncommitted" }, load })).toBe(first);
  deferred.reject(new Error("read failed"));
  await rejected;
  expect(
    await cache.read({
      cwd: "active",
      compare: { mode: "uncommitted" },
      load: async () => ({ diff: "retry" }),
    }),
  ).toEqual({ diff: "retry" });
});
