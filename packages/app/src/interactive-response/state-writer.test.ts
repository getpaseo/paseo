import { expect, it } from "vitest";
import { InteractiveStateWriter } from "./state-writer";
import type { InteractiveState } from "@getpaseo/protocol/interactive-response-schema";
it("coalesces edits behind an in-flight save and flushes the latest values", async () => {
  let release!: (revision: number) => void;
  const gate = new Promise<number>((resolve) => {
    release = resolve;
  });
  const calls: { revision: number; state: InteractiveState }[] = [];
  const errors: Error[] = [];
  const writer = new InteractiveStateWriter(
    0,
    async (revision, state) => {
      calls.push({ revision, state });
      if (revision === 0) return gate;
      return revision + 1;
    },
    (error) => errors.push(error),
  );
  writer.write({ notes: "a" });
  writer.write({ notes: "ab" });
  writer.write({ notes: "abc", plan: "Pro" });
  expect(calls).toEqual([{ revision: 0, state: { notes: "a" } }]);
  release(1);
  await writer.flush();
  expect(calls).toEqual([
    { revision: 0, state: { notes: "a" } },
    { revision: 1, state: { notes: "abc", plan: "Pro" } },
  ]);
  expect(writer.revision).toBe(2);
  expect(errors).toEqual([]);
});
it("stops after a conflict and keeps flush rejected for retries", async () => {
  const errors: Error[] = [];
  let calls = 0;
  const writer = new InteractiveStateWriter(
    0,
    async () => {
      calls++;
      throw new Error("revision conflict");
    },
    (error) => errors.push(error),
  );
  writer.write({ notes: "draft" });
  await expect(writer.flush()).rejects.toThrow("revision conflict");
  writer.write({ notes: "still local" });
  await expect(writer.flush()).rejects.toThrow("revision conflict");
  expect(calls).toBe(1);
  expect(errors.map((error) => error.message)).toEqual(["revision conflict"]);
});
it("does not lose an edit arriving as the previous save settles", async () => {
  let release!: (revision: number) => void;
  const gate = new Promise<number>((resolve) => {
    release = resolve;
  });
  const saved: InteractiveState[] = [];
  const writer = new InteractiveStateWriter(
    0,
    (revision, state) => {
      saved.push(state);
      return revision === 0 ? gate : Promise.resolve(revision + 1);
    },
    () => {},
  );
  writer.write({ notes: "first" });
  void gate.then(() => {
    writer.write({ notes: "latest" });
    return undefined;
  });
  const flushed = writer.flush();
  release(1);
  await flushed;
  expect(saved).toEqual([{ notes: "first" }, { notes: "latest" }]);
  expect(writer.revision).toBe(2);
});
