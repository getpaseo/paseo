import { describe, expect, it } from "vitest";
import {
  BackgroundTaskStore,
  isShellTaskType,
  isSubagentTaskType,
  isTrackableBackgroundTaskType,
} from "./store.js";

const PARENT = "00000000-0000-4000-8000-000000000001";

describe("BackgroundTaskStore", () => {
  it("includes monitor and workflow and excludes subagent", () => {
    const store = new BackgroundTaskStore();
    const tasks = store.replaceLiveSet(
      "parent-1",
      [
        { taskId: "s1", type: "shell", description: "npm run dev" },
        { taskId: "m1", type: "monitor", description: "watch deploy" },
        { taskId: "w1", type: "workflow", description: "review-changes" },
        { taskId: "a1", type: "subagent", description: "Explore" },
        { taskId: "o1", type: "mystery", description: "other work" },
      ],
      "2026-08-02T00:00:00.000Z",
    );
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["m1", "o1", "s1", "w1"]);
    expect(isSubagentTaskType("subagent")).toBe(true);
    expect(isTrackableBackgroundTaskType("monitor")).toBe(true);
    expect(isTrackableBackgroundTaskType("subagent")).toBe(false);
  });

  it("keeps non-subagent tasks and drops subagent on replace", () => {
    const store = new BackgroundTaskStore();
    const listed = store.replaceLiveSet(
      PARENT,
      [
        { taskId: "s1", type: "shell", description: "npm run dev" },
        { taskId: "a1", type: "subagent", description: "Explore" },
      ],
      "2026-08-01T00:00:00.000Z",
    );
    expect(listed.map((t) => t.taskId)).toEqual(["s1"]);
    expect(isShellTaskType("shell")).toBe(true);
    expect(isShellTaskType("subagent")).toBe(false);
    expect(isSubagentTaskType("subagent")).toBe(true);
    expect(isTrackableBackgroundTaskType("shell")).toBe(true);
  });

  it("replace drops tasks no longer present", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "one" }],
      "2026-08-01T00:00:00.000Z",
    );
    store.replaceLiveSet(PARENT, [], "2026-08-01T00:01:00.000Z");
    expect(store.list(PARENT)).toEqual([]);
  });

  it("enrich updates command and outputFile without inventing tasks", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    const updated = store.enrich(PARENT, "s1", {
      command: "npm run dev",
      outputFile: "/tmp/out.txt",
      updatedAt: "2026-08-01T00:00:05.000Z",
    });
    expect(updated?.command).toBe("npm run dev");
    expect(updated?.outputFile).toBe("/tmp/out.txt");
    expect(store.enrich(PARENT, "missing", { command: "x" })).toBeNull();
  });

  it("removes tasks from the live set on terminal status enrichment", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    const updated = store.enrich(PARENT, "s1", {
      status: "stopped",
      outputFile: "/tmp/out.txt",
      updatedAt: "2026-08-01T00:00:05.000Z",
    });
    expect(updated?.status).toBe("stopped");
    expect(updated?.outputFile).toBe("/tmp/out.txt");
    expect(store.get(PARENT, "s1")).toBeNull();
    expect(store.list(PARENT)).toEqual([]);
  });

  it("preserves enrichment across replace for the same task id", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    store.enrich(PARENT, "s1", {
      command: "npm run dev",
      outputFile: "/tmp/out.txt",
      updatedAt: "2026-08-01T00:00:05.000Z",
    });
    const listed = store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "Dev server" }],
      "2026-08-01T00:00:10.000Z",
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.command).toBe("npm run dev");
    expect(listed[0]?.outputFile).toBe("/tmp/out.txt");
    expect(listed[0]?.description).toBe("Dev server");
    expect(listed[0]?.status).toBe("running");
  });
});
