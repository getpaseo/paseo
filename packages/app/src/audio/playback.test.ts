import { expect, test } from "vitest";
import { createPlaybackQueue } from "./playback";

function harness() {
  const started: string[] = [];
  const finishes: (() => void)[] = [];
  const queue = createPlaybackQueue<string>((source, signal) => {
    started.push(source);
    return new Promise<number>((resolve, reject) => {
      finishes.push(() => resolve(1));
      signal.addEventListener("abort", () => reject(new Error("Playback stopped")), { once: true });
    });
  });
  return { queue, started, finishes };
}

test("plays in order and resolves only after playback completes", async () => {
  const h = harness();
  const first = h.queue.play("first");
  const second = h.queue.play("second");
  expect(h.started).toEqual(["first"]);
  h.finishes[0]();
  await expect(first).resolves.toBe(1);
  expect(h.started).toEqual(["first", "second"]);
  h.finishes[1]();
  await expect(second).resolves.toBe(1);
});

test("cancels one owner's queued and active work without stopping another owner", async () => {
  const h = harness();
  const owner = new AbortController();
  const first = h.queue.play("first", owner.signal);
  const queued = h.queue.play("cancelled", owner.signal);
  const other = h.queue.play("other");
  const rejected = Promise.all([
    expect(first).rejects.toThrow("Playback stopped"),
    expect(queued).rejects.toThrow("Playback stopped"),
  ]);
  owner.abort(new Error("unloaded"));
  await rejected;
  expect(h.started).toEqual(["first", "other"]);
  h.finishes[1]();
  await expect(other).resolves.toBe(1);
});

test("stop during loading cannot start cancelled audio or strand the next call", async () => {
  const h = harness();
  const first = h.queue.play("loading");
  const rejected = expect(first).rejects.toThrow("Playback stopped");
  h.queue.stop();
  await rejected;
  const second = h.queue.play("next");
  h.finishes[1]();
  await expect(second).resolves.toBe(1);
});

test("a failed file does not block the queue", async () => {
  const queue = createPlaybackQueue<string>(async (source) => {
    if (source === "invalid") throw new Error("Invalid audio");
    return 2;
  });
  const failed = queue.play("invalid");
  const next = queue.play("valid");
  await expect(failed).rejects.toThrow("Invalid audio");
  await expect(next).resolves.toBe(2);
});
