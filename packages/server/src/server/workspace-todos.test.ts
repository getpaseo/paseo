import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WorkspaceTodosStore } from "./workspace-todos.js";

describe("workspace project todos", () => {
  let directory: string;
  let store: WorkspaceTodosStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "paseo-todos-"));
    store = new WorkspaceTodosStore(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const initialize = () =>
    store.mutate(
      "a",
      0,
      { operation: "initialize", tasks: [{ title: "Plan", notes: "First step" }] },
      "agent",
    );
  test("isolates workspace identity and persists across restarts", async () => {
    const list = await initialize();
    expect(await store.read("b")).toEqual({ revision: 0, initialized: false, tasks: [] });
    expect(await new WorkspaceTodosStore(directory).read("a")).toEqual(list);
  });
  test("milestones persist, normalize and respect independent manual protection", async () => {
    let list = await store.mutate(
      "a",
      0,
      {
        operation: "initialize",
        tasks: [{ title: "First", notes: "", milestone: "  Delivery  " }],
      },
      "agent",
    );
    const id = list.tasks[0]!.id;
    expect(list.tasks[0]?.milestone).toBe("Delivery");
    list = await store.mutate(
      "a",
      list.revision,
      { operation: "add", title: "Second", notes: "", milestone: "Delivery" },
      "agent",
    );
    expect(list.tasks[1]?.milestone).toBe("Delivery");
    list = await store.mutate(
      "a",
      list.revision,
      { operation: "update", id, milestone: "Release" },
      "user",
    );
    await expect(
      store.mutate(
        "a",
        list.revision,
        { operation: "update", id, milestone: "Rewrite", status: "done" },
        "agent",
      ),
    ).rejects.toThrow("protected");
    expect((await store.read("a")).tasks[0]?.status).toBe("todo");
    await expect(
      store.mutate("a", list.revision, { operation: "delete", id }, "agent"),
    ).rejects.toThrow("cannot be deleted");
    list = await store.mutate(
      "a",
      list.revision,
      { operation: "update", id, title: "Agent title", notes: "Agent notes", status: "done" },
      "agent",
    );
    expect((await new WorkspaceTodosStore(directory).read("a")).tasks[0]).toMatchObject({
      milestone: "Release",
      milestoneProtected: true,
      status: "done",
    });
    list = await store.mutate(
      "a",
      list.revision,
      { operation: "update", id, milestone: "  " },
      "user",
    );
    expect(list.tasks[0]?.milestone).toBe("");
    expect((await store.read("a")).tasks[0]?.milestoneProtected).toBe(true);
  });
  test("old persisted tasks without milestones remain writable", async () => {
    const list = {
      revision: 7,
      initialized: true,
      tasks: [
        {
          id: "legacy",
          title: "Old task",
          notes: "Keep these notes",
          status: "todo",
          titleProtected: false,
          notesProtected: false,
        },
      ],
    };
    await writeFile(
      path.join(directory, `${Buffer.from("a").toString("hex")}.json`),
      JSON.stringify(list),
    );
    expect(await store.read("a")).toEqual(list);
    const next = await store.mutate(
      "a",
      7,
      { operation: "update", id: "legacy", milestone: "Delivery" },
      "agent",
    );
    expect(next.tasks[0]).toMatchObject({
      id: "legacy",
      notes: "Keep these notes",
      milestone: "Delivery",
    });
  });
  test("only one concurrent initialization wins", async () => {
    const results = await Promise.allSettled([initialize(), initialize()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.read("a")).tasks).toHaveLength(1);
  });
  test("deliberately empty lists cannot be initialized again", async () => {
    const list = await initialize();
    await store.mutate("a", 1, { operation: "delete", id: list.tasks[0]!.id }, "user");
    await expect(
      store.mutate("a", 2, { operation: "initialize", tasks: [] }, "agent"),
    ).rejects.toThrow("already initialized");
    expect((await store.read("a")).tasks).toEqual([]);
  });
  test("manual titles and notes are independently protected; status remains writable", async () => {
    const list = await initialize();
    const id = list.tasks[0]!.id;
    await store.mutate("a", 1, { operation: "update", id, title: "My plan" }, "user");
    await expect(
      store.mutate("a", 2, { operation: "update", id, title: "Agent title" }, "agent"),
    ).rejects.toThrow("protected");
    await store.mutate(
      "a",
      2,
      { operation: "update", id, notes: "Agent notes", status: "in_progress" },
      "agent",
    );
    await store.mutate("a", 3, { operation: "update", id, notes: "My notes" }, "user");
    await expect(
      store.mutate("a", 4, { operation: "update", id, notes: "Agent notes" }, "agent"),
    ).rejects.toThrow("protected");
    await expect(store.mutate("a", 4, { operation: "delete", id }, "agent")).rejects.toThrow(
      "cannot be deleted",
    );
    expect(
      (await store.mutate("a", 4, { operation: "update", id, status: "done" }, "agent")).tasks[0]
        ?.status,
    ).toBe("done");
  });
  test("stale revisions never overwrite committed edits", async () => {
    await initialize();
    await expect(
      store.mutate("a", 0, { operation: "add", title: "Lost", notes: "" }, "user"),
    ).rejects.toThrow("conflict");
    expect((await store.read("a")).revision).toBe(1);
  });
  test("reorder requires a permutation and preserves task identity", async () => {
    const first = await initialize();
    const list = await store.mutate(
      "a",
      1,
      { operation: "add", title: "Second", notes: "" },
      "agent",
    );
    const ids = list.tasks.map((task) => task.id).toReversed();
    await expect(
      store.mutate("a", 2, { operation: "reorder", ids: [ids[0]!, ids[0]!] }, "user"),
    ).rejects.toThrow("exactly once");
    expect((await store.mutate("a", 2, { operation: "reorder", ids }, "user")).tasks[1]?.id).toBe(
      first.tasks[0]?.id,
    );
  });
  test("observations publish committed lists only and unsubscribe", async () => {
    const revisions: number[] = [];
    const stop = store.subscribe("a", (list) => revisions.push(list.revision));
    await initialize();
    await expect(initialize()).rejects.toThrow("conflict");
    stop();
    await store.mutate("a", 1, { operation: "add", title: "Next", notes: "" }, "agent");
    expect(revisions).toEqual([1]);
  });
  test("storage failures leave the saved revision unchanged", async () => {
    const list = await initialize();
    const file = path.join(directory, `${Buffer.from("a").toString("hex")}.json`);
    await rm(file);
    await mkdir(file);
    await expect(
      store.mutate("a", 1, { operation: "add", title: "Next", notes: "" }, "user"),
    ).rejects.toThrow();
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify(list));
    expect(await store.read("a")).toEqual(list);
  });
});
