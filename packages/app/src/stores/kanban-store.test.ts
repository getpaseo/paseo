import { describe, expect, test, beforeEach, vi } from "vitest";

// Mock AsyncStorage before importing the store
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}));

import { useKanbanStore, selectTasksByStatus } from "./kanban-store";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";

function createTestTask(overrides?: Partial<KanbanTask>): KanbanTask {
  return {
    id: `test-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Task",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("kanban-store", () => {
  beforeEach(() => {
    // Reset store state between tests
    useKanbanStore.setState({ statusByTask: {}, tasks: [] });
  });

  describe("addTask", () => {
    test("adds a task to the store", () => {
      const task = createTestTask({ name: "My Task" });
      useKanbanStore.getState().addTask(task);

      const state = useKanbanStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0]).toEqual(task);
    });

    test("new tasks default to 'todo' status", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);

      expect(useKanbanStore.getState().statusByTask[task.id]).toBe("todo");
    });

    test("adding multiple tasks preserves existing ones", () => {
      const task1 = createTestTask({ name: "Task 1" });
      const task2 = createTestTask({ name: "Task 2" });

      useKanbanStore.getState().addTask(task1);
      useKanbanStore.getState().addTask(task2);

      expect(useKanbanStore.getState().tasks).toHaveLength(2);
    });
  });

  describe("removeTask", () => {
    test("removes a task by id", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().removeTask(task.id);

      expect(useKanbanStore.getState().tasks).toHaveLength(0);
    });

    test("removes status entry when task is removed", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().setStatus(task.id, "in-progress");
      useKanbanStore.getState().removeTask(task.id);

      expect(useKanbanStore.getState().statusByTask[task.id]).toBeUndefined();
    });

    test("does not affect other tasks", () => {
      const task1 = createTestTask({ name: "Keep" });
      const task2 = createTestTask({ name: "Remove" });

      useKanbanStore.getState().addTask(task1);
      useKanbanStore.getState().addTask(task2);
      useKanbanStore.getState().removeTask(task2.id);

      const remaining = useKanbanStore.getState().tasks;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe("Keep");
    });
  });

  describe("updateTask", () => {
    test("updates task fields", () => {
      const task = createTestTask({ name: "Original" });
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().updateTask(task.id, { name: "Updated" });

      const updated = useKanbanStore.getState().tasks[0];
      expect(updated.name).toBe("Updated");
      expect(updated.id).toBe(task.id);
    });

    test("can set agentMode and agentProvider", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().updateTask(task.id, {
        agentMode: "cli",
        agentProvider: "gemini",
      });

      const updated = useKanbanStore.getState().tasks[0];
      expect(updated.agentMode).toBe("cli");
      expect(updated.agentProvider).toBe("gemini");
    });

    test("can set terminalId for CLI agent tasks", () => {
      const task = createTestTask({ agentMode: "cli", agentProvider: "claude" });
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().updateTask(task.id, { terminalId: "term-123" });

      expect(useKanbanStore.getState().tasks[0].terminalId).toBe("term-123");
    });

    test("does not modify other tasks", () => {
      const task1 = createTestTask({ name: "First" });
      const task2 = createTestTask({ name: "Second" });

      useKanbanStore.getState().addTask(task1);
      useKanbanStore.getState().addTask(task2);
      useKanbanStore.getState().updateTask(task1.id, { name: "Modified" });

      const tasks = useKanbanStore.getState().tasks;
      expect(tasks[0].name).toBe("Modified");
      expect(tasks[1].name).toBe("Second");
    });
  });

  describe("setStatus", () => {
    test("sets status for a task", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().setStatus(task.id, "in-progress");

      expect(useKanbanStore.getState().statusByTask[task.id]).toBe("in-progress");
    });

    test("can transition through all statuses", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);

      const statuses: KanbanStatus[] = ["todo", "in-progress", "done"];
      for (const status of statuses) {
        useKanbanStore.getState().setStatus(task.id, status);
        expect(useKanbanStore.getState().statusByTask[task.id]).toBe(status);
      }
    });
  });

  describe("getStatus", () => {
    test("returns todo for unknown task", () => {
      expect(useKanbanStore.getState().getStatus("nonexistent")).toBe("todo");
    });

    test("returns current status", () => {
      const task = createTestTask();
      useKanbanStore.getState().addTask(task);
      useKanbanStore.getState().setStatus(task.id, "done");

      expect(useKanbanStore.getState().getStatus(task.id)).toBe("done");
    });
  });

  describe("clearAll", () => {
    test("removes all tasks and statuses", () => {
      const task1 = createTestTask();
      const task2 = createTestTask();

      useKanbanStore.getState().addTask(task1);
      useKanbanStore.getState().addTask(task2);
      useKanbanStore.getState().setStatus(task1.id, "in-progress");
      useKanbanStore.getState().clearAll();

      const state = useKanbanStore.getState();
      expect(state.tasks).toHaveLength(0);
      expect(Object.keys(state.statusByTask)).toHaveLength(0);
    });
  });

  describe("archiveByWorkspacePath", () => {
    test("removes all tasks linked to the given workspace path", () => {
      const taskA = createTestTask({ path: "/repo/worktree-a" });
      const taskB = createTestTask({ path: "/repo/worktree-b" });
      const taskC = createTestTask(); // no path

      useKanbanStore.getState().addTask(taskA);
      useKanbanStore.getState().addTask(taskB);
      useKanbanStore.getState().addTask(taskC);

      useKanbanStore.getState().archiveByWorkspacePath("/repo/worktree-a");

      const ids = useKanbanStore.getState().tasks.map((t) => t.id);
      expect(ids).not.toContain(taskA.id);
      expect(ids).toContain(taskB.id);
      expect(ids).toContain(taskC.id);
      expect(useKanbanStore.getState().statusByTask[taskA.id]).toBeUndefined();
    });

    test("is a no-op when no tasks match the path", () => {
      const task = createTestTask({ path: "/repo/other" });
      useKanbanStore.getState().addTask(task);
      const before = useKanbanStore.getState();

      useKanbanStore.getState().archiveByWorkspacePath("/repo/nonexistent");

      // State object reference is the same (no update triggered)
      expect(useKanbanStore.getState()).toBe(before);
    });
  });

  // ── Integration-linked task tests ──────────────────────────────────────────

  describe("integration context persistence", () => {
    test("persists linearIssueId and full issue metadata together", () => {
      const task = createTestTask({
        integrations: { linearIssueId: "BRA-3" },
        metadata: {
          linearIssue: {
            id: "uuid-linear",
            identifier: "BRA-3",
            title: "connect your tools",
            state: { name: "Todo" },
          },
        },
      });
      useKanbanStore.getState().addTask(task);

      const stored = useKanbanStore.getState().tasks[0];
      expect(stored?.integrations?.linearIssueId).toBe("BRA-3");
      expect(stored?.metadata?.linearIssue?.identifier).toBe("BRA-3");
      expect(stored?.metadata?.linearIssue?.title).toBe("connect your tools");
      expect(stored?.metadata?.linearIssue?.state?.name).toBe("Todo");
    });

    test("persists githubIssueId and full issue metadata together", () => {
      const task = createTestTask({
        integrations: { githubIssueId: "42" },
        metadata: {
          githubIssue: { id: 42, number: 42, title: "Add dark mode", state: "open" },
        },
      });
      useKanbanStore.getState().addTask(task);

      const stored = useKanbanStore.getState().tasks[0];
      expect(stored?.integrations?.githubIssueId).toBe("42");
      expect(stored?.metadata?.githubIssue?.number).toBe(42);
      expect(stored?.metadata?.githubIssue?.title).toBe("Add dark mode");
    });

    test("integration context survives an updateTask call for path/serverId", () => {
      const task = createTestTask({
        integrations: { linearIssueId: "BRA-3" },
        metadata: {
          linearIssue: { id: "uid", identifier: "BRA-3", title: "connect your tools" },
        },
      });
      useKanbanStore.getState().addTask(task);

      // Simulate handleTaskCreated stamping workspace path — must not wipe integration data
      useKanbanStore.getState().updateTask(task.id, {
        path: "/home/user/projects/BRA-3-connect-your-tools",
        serverId: "server-1",
        projectId: "proj-1",
        projectName: "my-app",
      });

      const updated = useKanbanStore.getState().tasks[0];
      expect(updated?.integrations?.linearIssueId).toBe("BRA-3");
      expect(updated?.metadata?.linearIssue?.title).toBe("connect your tools");
      expect(updated?.path).toBe("/home/user/projects/BRA-3-connect-your-tools");
    });

    test("updateTask can refresh issue metadata with fresh data from integration", () => {
      const task = createTestTask({
        integrations: { linearIssueId: "BRA-3" },
        metadata: {
          linearIssue: { id: "uid", identifier: "BRA-3", title: "old title" },
        },
      });
      useKanbanStore.getState().addTask(task);

      // Simulate useTaskIntegrationRefresh updating with fresh server data
      useKanbanStore.getState().updateTask(task.id, {
        metadata: {
          ...task.metadata,
          linearIssue: {
            id: "uid",
            identifier: "BRA-3",
            title: "connect your tools (updated)",
            state: { name: "In Progress" },
          },
        },
      });

      const updated = useKanbanStore.getState().tasks[0];
      expect(updated?.metadata?.linearIssue?.title).toBe("connect your tools (updated)");
      expect(updated?.metadata?.linearIssue?.state?.name).toBe("In Progress");
      // Integration ID must remain
      expect(updated?.integrations?.linearIssueId).toBe("BRA-3");
    });
  });

  // ── Workspace creation flow ────────────────────────────────────────────────

  describe("workspace creation → task linking flow", () => {
    test("task starts without path, gets path stamped after worktree creation", () => {
      // Step 1: modal creates the task with integration data but no path yet
      const task = createTestTask({
        serverId: "server-1",
        projectId: "proj-1",
        integrations: { linearIssueId: "BRA-3" },
        metadata: {
          linearIssue: { id: "uid", identifier: "BRA-3", title: "connect your tools" },
        },
      });
      useKanbanStore.getState().addTask(task);
      expect(useKanbanStore.getState().tasks[0]?.path).toBeUndefined();
      // Status is 'todo' — no agent launched yet
      expect(useKanbanStore.getState().getStatus(task.id)).toBe("todo");

      // Step 2: handleTaskCreated stamps the workspace path (no agent, no navigate)
      useKanbanStore.getState().updateTask(task.id, {
        path: "/home/user/projects/BRA-3-connect-your-tools",
        serverId: "server-1",
        projectId: "proj-1",
        projectName: "my-app",
      });

      const updated = useKanbanStore.getState().tasks[0];
      expect(updated?.path).toBe("/home/user/projects/BRA-3-connect-your-tools");
      expect(updated?.integrations?.linearIssueId).toBe("BRA-3");
      // Status is STILL 'todo' — user hasn't opened the task yet
      expect(useKanbanStore.getState().getStatus(task.id)).toBe("todo");
    });

    test("task moves to in-progress only when user opens it from kanban (handleOpenTask)", () => {
      const task = createTestTask({
        path: "/repo/worktree",
        agentProvider: "claude",
        integrations: { linearIssueId: "BRA-3" },
      });
      useKanbanStore.getState().addTask(task);
      expect(useKanbanStore.getState().getStatus(task.id)).toBe("todo");

      // Simulate handleOpenTask: stamp agentId and set status to in-progress
      useKanbanStore.getState().updateTask(task.id, { agentId: "agent-xyz" });
      useKanbanStore.getState().setStatus(task.id, "in-progress");

      expect(useKanbanStore.getState().getStatus(task.id)).toBe("in-progress");
      expect(useKanbanStore.getState().tasks[0]?.agentId).toBe("agent-xyz");
      // Integration data intact
      expect(useKanbanStore.getState().tasks[0]?.integrations?.linearIssueId).toBe("BRA-3");
    });
  });
});

describe("selectTasksByStatus", () => {
  test("groups tasks by status", () => {
    const task1 = createTestTask({ id: "t1" });
    const task2 = createTestTask({ id: "t2" });
    const task3 = createTestTask({ id: "t3" });

    const result = selectTasksByStatus([task1, task2, task3], {
      t1: "todo",
      t2: "in-progress",
      t3: "done",
    });

    expect(result.todo).toHaveLength(1);
    expect(result["in-progress"]).toHaveLength(1);
    expect(result.done).toHaveLength(1);
    expect(result.todo[0].id).toBe("t1");
    expect(result["in-progress"][0].id).toBe("t2");
    expect(result.done[0].id).toBe("t3");
  });

  test("tasks without status default to todo", () => {
    const task = createTestTask({ id: "t1" });

    const result = selectTasksByStatus([task], {});
    expect(result.todo).toHaveLength(1);
    expect(result["in-progress"]).toHaveLength(0);
    expect(result.done).toHaveLength(0);
  });

  test("returns empty arrays when no tasks", () => {
    const result = selectTasksByStatus([], {});
    expect(result.todo).toEqual([]);
    expect(result["in-progress"]).toEqual([]);
    expect(result.done).toEqual([]);
  });

  test("multiple tasks in same status", () => {
    const tasks = [
      createTestTask({ id: "t1" }),
      createTestTask({ id: "t2" }),
      createTestTask({ id: "t3" }),
    ];

    const result = selectTasksByStatus(tasks, {
      t1: "in-progress",
      t2: "in-progress",
      t3: "in-progress",
    });

    expect(result["in-progress"]).toHaveLength(3);
  });
});
