import { expect, test } from "vitest";
import { CompactionPromptQueue } from "./compaction-prompt-queue.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("canceling during an asynchronous admission prevents delivery", async () => {
  const release = gate();
  const checked = gate();
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const queue = new CompactionPromptQueue<string>({
    deliver: async ({ entry: prompt, isCurrent }) => {
      await release.promise;
      if (isCurrent()) delivered.push(prompt);
      checked.resolve();
      return true;
    },
    failed: ({ error }) => {
      errors.push(error);
    },
  });
  expect(queue.enqueue({ agentId: "agent", entry: "first", compacting: true })).toBe(true);
  expect(queue.enqueue({ agentId: "agent", entry: "second", compacting: false })).toBe(true);
  expect(queue.cancel("agent")).toBe(2);
  release.resolve();
  await checked.promise;
  expect(delivered).toEqual([]);
  expect(errors).toEqual([]);
});

test("an ambiguous delivery failure is reported once without retrying or duplicating messages", async () => {
  const failed = gate();
  const attempted: string[] = [];
  const errors: unknown[] = [];
  const failure = new Error("connection lost after acceptance");
  const canceled: Array<{ entry: string; error: Error }> = [];
  const queue = new CompactionPromptQueue<string>({
    deliver: async ({ entry: prompt }) => {
      attempted.push(prompt);
      throw failure;
    },
    failed: ({ error }) => {
      errors.push(error);
      failed.resolve();
    },
    canceled: (input) => canceled.push(input),
  });
  queue.enqueue({ agentId: "agent", entry: "first", compacting: true });
  queue.enqueue({ agentId: "agent", entry: "second", compacting: false });
  await failed.promise;
  queue.wake("agent");
  expect(attempted).toEqual(["first"]);
  expect(errors).toEqual([failure]);
  expect(
    canceled.map(({ entry, error }) => ({ entry, message: error.message, cause: error.cause })),
  ).toEqual([
    { entry: "first", message: "Queued prompt delivery failed", cause: failure },
    { entry: "second", message: "Queued prompt delivery failed", cause: failure },
  ]);
  expect(queue.enqueue({ agentId: "agent", entry: "new request", compacting: false })).toBe(false);
});

test("a stale admission cannot cancel a newer queue", async () => {
  const releaseOld = gate();
  const oldChecked = gate();
  const newDelivered = gate();
  const delivered: string[] = [];
  const errors: unknown[] = [];
  let compacting = true;
  const queue = new CompactionPromptQueue<string>({
    deliver: async ({ entry: prompt }) => {
      if (prompt === "old") {
        await releaseOld.promise;
        oldChecked.resolve();
        throw new Error("old turn canceled");
      }
      if (compacting) return false;
      delivered.push(prompt);
      newDelivered.resolve();
      return true;
    },
    failed: ({ error }) => {
      errors.push(error);
    },
  });
  queue.enqueue({ agentId: "agent", entry: "old", compacting: true });
  queue.cancel("agent");
  queue.enqueue({ agentId: "agent", entry: "new", compacting: true });
  releaseOld.resolve();
  await oldChecked.promise;
  compacting = false;
  queue.wake("agent");
  await newDelivered.promise;
  expect(delivered).toEqual(["new"]);
  expect(errors).toEqual([]);
});
