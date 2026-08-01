import { beforeEach, describe, expect, it } from "vitest";
import { selectBackgroundTasksForParent, useBackgroundTaskStore } from "./store";

describe("background task store", () => {
  beforeEach(() => {
    useBackgroundTaskStore.setState({ tasks: new Map() });
  });

  it("replaces tasks for a parent agent", () => {
    useBackgroundTaskStore.getState().replaceList("srv", "agent-1", [
      {
        taskId: "s1",
        parentAgentId: "agent-1",
        type: "shell",
        description: "dev",
        command: "npm run dev",
        status: "running",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const all = [...useBackgroundTaskStore.getState().tasks.values()];
    expect(all).toHaveLength(1);
    expect(all[0]?.taskId).toBe("s1");
  });

  it("selects only the parent agent tasks", () => {
    useBackgroundTaskStore.getState().replaceList("srv", "agent-1", [
      {
        taskId: "s1",
        parentAgentId: "agent-1",
        type: "shell",
        description: "one",
        status: "running",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    useBackgroundTaskStore.getState().replaceList("srv", "agent-2", [
      {
        taskId: "s2",
        parentAgentId: "agent-2",
        type: "shell",
        description: "two",
        status: "running",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const rows = selectBackgroundTasksForParent(
      useBackgroundTaskStore.getState().tasks,
      "srv",
      "agent-1",
    );
    expect(rows.map((row) => row.taskId)).toEqual(["s1"]);
  });
});
