import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentQueueStore } from "./agent-queue-store.js";

const directories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-queue-"));
  directories.push(directory);
  return {
    directory,
    store: new AgentQueueStore(directory, () => new Date("2026-08-24T12:00:00.000Z")),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

test("persists FIFO prompts and supports a later store instance", async () => {
  const { directory, store } = await createStore();
  const first = await store.enqueue({ agentId: "agent-1", text: "first", createdByClientId: "a" });
  const second = await store.enqueue({
    agentId: "agent-1",
    text: "second",
    createdByClientId: "b",
  });
  expect((await store.list("agent-1")).map((prompt) => prompt.text)).toEqual(["first", "second"]);

  const persisted = JSON.parse(
    await readFile(path.join(directory, "queues", "agent-1.json"), "utf8"),
  );
  expect(persisted.prompts.map((prompt: { id: string }) => prompt.id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("serializes concurrent mutations and rejects incomplete reorders", async () => {
  const { store } = await createStore();
  const [first, second, third] = await Promise.all(
    ["first", "second", "third"].map((text) =>
      store.enqueue({ agentId: "agent-1", text, createdByClientId: "client" }),
    ),
  );
  await expect(store.reorder("agent-1", [first.id])).rejects.toThrow("every prompt");
  const reordered = await store.reorder("agent-1", [third.id, second.id, first.id]);
  expect(reordered.map((prompt) => prompt.id)).toEqual([third.id, second.id, first.id]);
  expect((await store.take("agent-1"))?.id).toBe(third.id);
});
