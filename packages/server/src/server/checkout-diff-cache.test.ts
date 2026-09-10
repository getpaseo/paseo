import { expect, test } from "vitest";
import { CheckoutDiffCache } from "./checkout-diff-cache.js";

test("reads after invalidation wait for fresh work without overlapping the original read", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const first = Promise.withResolvers<{ diff: string }>();
  const second = Promise.withResolvers<{ diff: string }>();
  let calls = 0;
  const load = () => (++calls === 1 ? first.promise : second.promise);
  const read = () => cache.read("repo", { mode: "base" }, undefined, load);
  const pending = read();
  await Promise.resolve();
  cache.invalidate("repo", "base");
  cache.invalidate("repo", "base");
  const fresh = read();
  const another = read();
  expect(calls).toBe(1);
  first.resolve({ diff: "old" });
  expect(await pending).toEqual({ diff: "old" });
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(2);
  second.resolve({ diff: "new" });
  expect(await fresh).toEqual({ diff: "new" });
  expect(await another).toEqual({ diff: "new" });
  expect(await read()).toEqual({ diff: "new" });
  expect(calls).toBe(2);
});

test("edits during a read do not delay its caller or cache its outdated snapshot", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const deferred = Promise.withResolvers<{ diff: string }>();
  let calls = 0;
  const load = () => {
    calls += 1;
    return deferred.promise;
  };
  const pending = cache.read("repo", { mode: "uncommitted" }, undefined, load);
  await Promise.resolve();
  cache.invalidate("repo", "uncommitted");
  deferred.resolve({ diff: "snapshot" });
  expect(await pending).toEqual({ diff: "snapshot" });
  expect(calls).toBe(1);
  expect(
    await cache.read("repo", { mode: "uncommitted" }, undefined, async () => ({ diff: "fresh" })),
  ).toEqual({ diff: "fresh" });
});

test("active reads survive completed-payload eviction and failed reads can retry", async () => {
  const cache = new CheckoutDiffCache(() => 0);
  const deferred = Promise.withResolvers<{ diff: string }>();
  const load = () => deferred.promise;
  const first = cache.read("active", { mode: "uncommitted" }, undefined, load);
  const rejected = expect(first).rejects.toThrow("read failed");
  for (let i = 0; i < 70; i++)
    await cache.read(String(i), { mode: "base" }, undefined, async () => ({ diff: "" }));
  expect(cache.read("active", { mode: "uncommitted" }, undefined, load)).toBe(first);
  deferred.reject(new Error("read failed"));
  await rejected;
  expect(
    await cache.read("active", { mode: "uncommitted" }, undefined, async () => ({ diff: "retry" })),
  ).toEqual({ diff: "retry" });
});
