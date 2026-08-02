import { describe, expect, it } from "vitest";
import { ProviderHeartbeatStore, type ProviderHeartbeatDescriptor } from "./store.js";

const PARENT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function heartbeat(
  partial: Partial<ProviderHeartbeatDescriptor> & Pick<ProviderHeartbeatDescriptor, "taskId">,
): ProviderHeartbeatDescriptor {
  return {
    parentAgentId: PARENT,
    provider: "claude",
    prompt: "check deploy",
    mode: "recurring",
    scheduleLabel: "0 * * * *",
    nextHint: null,
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...partial,
  };
}

describe("ProviderHeartbeatStore", () => {
  it("upserts and lists heartbeats for a parent", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(
      PARENT,
      heartbeat({
        taskId: "cron-1",
        prompt: "hourly check",
        scheduleLabel: "0 * * * *",
      }),
    );
    store.upsert(
      PARENT,
      heartbeat({
        taskId: "dyn-1",
        mode: "dynamic",
        scheduleLabel: "self-paced",
        prompt: "continue loop",
        nextHint: "in 120s",
        updatedAt: "2026-08-02T00:01:00.000Z",
      }),
    );

    expect(store.list(PARENT).map((row) => row.taskId)).toEqual(["cron-1", "dyn-1"]);
    expect(store.list(OTHER)).toEqual([]);
  });

  it("replaceLiveSet drops tasks no longer present for that parent only", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(PARENT, heartbeat({ taskId: "a" }));
    store.upsert(PARENT, heartbeat({ taskId: "b" }));
    store.upsert(OTHER, heartbeat({ taskId: "x", parentAgentId: OTHER }));

    const listed = store.replaceLiveSet(PARENT, [
      heartbeat({
        taskId: "b",
        prompt: "kept",
        updatedAt: "2026-08-02T00:05:00.000Z",
      }),
      heartbeat({
        taskId: "c",
        prompt: "new",
        mode: "one_shot",
        updatedAt: "2026-08-02T00:05:00.000Z",
      }),
    ]);

    expect(listed.map((row) => row.taskId)).toEqual(["b", "c"]);
    expect(listed.find((row) => row.taskId === "b")?.prompt).toBe("kept");
    expect(store.list(OTHER).map((row) => row.taskId)).toEqual(["x"]);
  });

  it("remove deletes a single task and returns whether it existed", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(PARENT, heartbeat({ taskId: "a" }));
    expect(store.remove(PARENT, "a")).toBe(true);
    expect(store.remove(PARENT, "a")).toBe(false);
    expect(store.list(PARENT)).toEqual([]);
  });

  it("deleteParent clears all tasks for one agent", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(PARENT, heartbeat({ taskId: "a" }));
    store.upsert(PARENT, heartbeat({ taskId: "b" }));
    store.upsert(OTHER, heartbeat({ taskId: "x", parentAgentId: OTHER }));
    store.deleteParent(PARENT);
    expect(store.list(PARENT)).toEqual([]);
    expect(store.list(OTHER).map((row) => row.taskId)).toEqual(["x"]);
  });

  it("upsert overwrites an existing task id", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(PARENT, heartbeat({ taskId: "a", prompt: "old" }));
    store.upsert(
      PARENT,
      heartbeat({
        taskId: "a",
        prompt: "new",
        mode: "one_shot",
        updatedAt: "2026-08-02T00:10:00.000Z",
      }),
    );
    const listed = store.list(PARENT);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.prompt).toBe("new");
    expect(listed[0]?.mode).toBe("one_shot");
  });
});
