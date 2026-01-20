import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskStore } from "./task-store.js";

describe("FileTaskStore", () => {
  let tempDir: string;
  let store: FileTaskStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "task-store-test-"));
    store = new FileTaskStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a task with default status open", async () => {
      const task = await store.create("My first task");

      expect(task.id).toMatch(/^[a-f0-9]{8}$/);
      expect(task.title).toBe("My first task");
      expect(task.status).toBe("open");
      expect(task.deps).toEqual([]);
      expect(task.parentId).toBeUndefined();
      expect(task.body).toBe("");
      expect(task.notes).toEqual([]);
      expect(task.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task.assignee).toBeUndefined();
      expect(task.priority).toBeUndefined();
    });

    it("creates a task with priority", async () => {
      const task = await store.create("High priority task", { priority: 1 });

      expect(task.priority).toBe(1);
    });

    it("creates a task with custom status", async () => {
      const task = await store.create("Draft task", { status: "draft" });

      expect(task.status).toBe("draft");
    });

    it("creates a task with dependencies", async () => {
      const dep1 = await store.create("Dependency 1");
      const dep2 = await store.create("Dependency 2");
      const task = await store.create("Main task", {
        deps: [dep1.id, dep2.id],
      });

      expect(task.deps).toEqual([dep1.id, dep2.id]);
    });

    it("creates a task with body", async () => {
      const task = await store.create("Task with body", {
        body: "This is a **long** body\n\nWith multiple lines.",
      });

      expect(task.body).toBe(
        "This is a **long** body\n\nWith multiple lines."
      );
    });

    it("creates a task with parentId", async () => {
      const parent = await store.create("Parent task");
      const child = await store.create("Child task", { parentId: parent.id });

      expect(child.parentId).toBe(parent.id);
    });

    it("throws when creating task with non-existent parent", async () => {
      await expect(
        store.create("Child", { parentId: "nonexistent" })
      ).rejects.toThrow("Parent task not found");
    });

    it("creates a task with assignee", async () => {
      const task = await store.create("Task for Claude", {
        assignee: "claude",
      });

      expect(task.assignee).toBe("claude");
    });

    it("generates unique IDs for each task", async () => {
      const task1 = await store.create("Task 1");
      const task2 = await store.create("Task 2");
      const task3 = await store.create("Task 3");

      const ids = [task1.id, task2.id, task3.id];
      expect(new Set(ids).size).toBe(3);
    });

    it("sets created timestamp", async () => {
      const before = new Date().toISOString();
      const task = await store.create("Task");
      const after = new Date().toISOString();

      expect(task.created >= before).toBe(true);
      expect(task.created <= after).toBe(true);
    });

    it("returns task with raw content", async () => {
      const task = await store.create("Test task", {
        body: "Task body here",
        acceptanceCriteria: ["criterion 1", "criterion 2"],
      });

      expect(task.raw).toContain("---");
      expect(task.raw).toContain("title: Test task");
      expect(task.raw).toContain("Task body here");
      expect(task.raw).toContain("## Acceptance Criteria");
      expect(task.raw).toContain("criterion 1");
      expect(task.raw).toContain("criterion 2");
    });
  });

  describe("get", () => {
    it("returns task by id", async () => {
      const created = await store.create("Test task");
      const retrieved = await store.get(created.id);

      expect(retrieved).toEqual(created);
    });

    it("returns null for non-existent task", async () => {
      const result = await store.get("nonexistent");

      expect(result).toBeNull();
    });

    it("preserves assignee field", async () => {
      const created = await store.create("Task", { assignee: "codex" });
      const retrieved = await store.get(created.id);

      expect(retrieved?.assignee).toBe("codex");
    });

    it("returns raw content matching the file", async () => {
      const created = await store.create("Task with body", {
        body: "Some body content",
        acceptanceCriteria: ["test passes", "lint passes"],
      });
      await store.addNote(created.id, "A note was added");

      const retrieved = await store.get(created.id);

      expect(retrieved?.raw).toContain("title: Task with body");
      expect(retrieved?.raw).toContain("Some body content");
      expect(retrieved?.raw).toContain("## Acceptance Criteria");
      expect(retrieved?.raw).toContain("test passes");
      expect(retrieved?.raw).toContain("lint passes");
      expect(retrieved?.raw).toContain("## Notes");
      expect(retrieved?.raw).toContain("A note was added");
    });
  });

  describe("list", () => {
    it("returns empty array when no tasks", async () => {
      const tasks = await store.list();

      expect(tasks).toEqual([]);
    });

    it("returns all tasks", async () => {
      await store.create("Task 1");
      await store.create("Task 2");
      await store.create("Task 3");

      const tasks = await store.list();

      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.title).sort()).toEqual([
        "Task 1",
        "Task 2",
        "Task 3",
      ]);
    });
  });

  describe("update", () => {
    it("updates task title", async () => {
      const task = await store.create("Original title");
      const updated = await store.update(task.id, { title: "New title" });

      expect(updated.title).toBe("New title");
      expect(updated.id).toBe(task.id);
    });

    it("updates task body", async () => {
      const task = await store.create("Task");
      const updated = await store.update(task.id, {
        body: "New body",
      });

      expect(updated.body).toBe("New body");
    });

    it("updates task assignee", async () => {
      const task = await store.create("Task");
      const updated = await store.update(task.id, { assignee: "claude" });

      expect(updated.assignee).toBe("claude");
    });

    it("persists updates", async () => {
      const task = await store.create("Task");
      await store.update(task.id, { title: "Updated" });

      const retrieved = await store.get(task.id);
      expect(retrieved?.title).toBe("Updated");
    });

    it("preserves created timestamp on update", async () => {
      const task = await store.create("Task");
      const originalCreated = task.created;

      await new Promise((r) => setTimeout(r, 10));
      await store.update(task.id, { title: "Updated" });

      const retrieved = await store.get(task.id);
      expect(retrieved?.created).toBe(originalCreated);
    });

    it("throws for non-existent task", async () => {
      await expect(
        store.update("nonexistent", { title: "New" })
      ).rejects.toThrow();
    });

    it("replaces acceptance criteria", async () => {
      const task = await store.create("Task", {
        acceptanceCriteria: ["old criterion 1", "old criterion 2"],
      });

      const updated = await store.update(task.id, {
        acceptanceCriteria: ["new criterion"],
      });

      expect(updated.acceptanceCriteria).toEqual(["new criterion"]);
    });

    it("clears acceptance criteria with empty array", async () => {
      const task = await store.create("Task", {
        acceptanceCriteria: ["criterion 1", "criterion 2"],
      });

      const updated = await store.update(task.id, {
        acceptanceCriteria: [],
      });

      expect(updated.acceptanceCriteria).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes a task", async () => {
      const task = await store.create("Task to delete");
      await store.delete(task.id);

      const retrieved = await store.get(task.id);
      expect(retrieved).toBeNull();
    });

    it("removes task from list", async () => {
      const task1 = await store.create("Task 1");
      const task2 = await store.create("Task 2");
      await store.delete(task1.id);

      const tasks = await store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task2.id);
    });

    it("throws for non-existent task", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow();
    });
  });

  describe("status transitions", () => {
    describe("open", () => {
      it("transitions draft to open", async () => {
        const task = await store.create("Draft", { status: "draft" });
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });

      it("reopens a done task", async () => {
        const task = await store.create("Task");
        await store.close(task.id);
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });

      it("reopens a failed task", async () => {
        const task = await store.create("Task");
        await store.fail(task.id);
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });

      it("reopens an in_progress task", async () => {
        const task = await store.create("Task");
        await store.start(task.id);
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });

      it("is idempotent for already open task", async () => {
        const task = await store.create("Task");
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });
    });

    describe("start", () => {
      it("transitions open to in_progress", async () => {
        const task = await store.create("Task");
        await store.start(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("in_progress");
      });

      it("throws when task is draft", async () => {
        const task = await store.create("Draft", { status: "draft" });

        await expect(store.start(task.id)).rejects.toThrow();
      });

      it("throws when task is already done", async () => {
        const task = await store.create("Task");
        await store.close(task.id);

        await expect(store.start(task.id)).rejects.toThrow();
      });
    });

    describe("close", () => {
      it("transitions open to done", async () => {
        const task = await store.create("Task");
        await store.close(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("done");
      });

      it("transitions in_progress to done", async () => {
        const task = await store.create("Task");
        await store.start(task.id);
        await store.close(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("done");
      });

      it("transitions draft to done", async () => {
        const task = await store.create("Task", { status: "draft" });
        await store.close(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("done");
      });
    });
  });

  describe("dependencies", () => {
    describe("addDep", () => {
      it("adds a dependency", async () => {
        const dep = await store.create("Dependency");
        const task = await store.create("Task");

        await store.addDep(task.id, dep.id);

        const updated = await store.get(task.id);
        expect(updated?.deps).toContain(dep.id);
      });

      it("does not duplicate dependencies", async () => {
        const dep = await store.create("Dependency");
        const task = await store.create("Task");

        await store.addDep(task.id, dep.id);
        await store.addDep(task.id, dep.id);

        const updated = await store.get(task.id);
        expect(updated?.deps).toEqual([dep.id]);
      });

      it("throws for non-existent task", async () => {
        const dep = await store.create("Dependency");

        await expect(store.addDep("nonexistent", dep.id)).rejects.toThrow();
      });

      it("throws for non-existent dependency", async () => {
        const task = await store.create("Task");

        await expect(store.addDep(task.id, "nonexistent")).rejects.toThrow();
      });
    });

    describe("removeDep", () => {
      it("removes a dependency", async () => {
        const dep = await store.create("Dependency");
        const task = await store.create("Task", { deps: [dep.id] });

        await store.removeDep(task.id, dep.id);

        const updated = await store.get(task.id);
        expect(updated?.deps).toEqual([]);
      });

      it("is idempotent for non-existent dep", async () => {
        const task = await store.create("Task");

        await store.removeDep(task.id, "nonexistent");

        const updated = await store.get(task.id);
        expect(updated?.deps).toEqual([]);
      });
    });
  });

  describe("notes", () => {
    it("adds a note with timestamp", async () => {
      const task = await store.create("Task");
      const before = new Date().toISOString();

      await store.addNote(task.id, "This is a note");

      const updated = await store.get(task.id);
      expect(updated?.notes).toHaveLength(1);
      expect(updated?.notes[0].content).toBe("This is a note");
      expect(updated?.notes[0].timestamp >= before).toBe(true);
    });

    it("appends multiple notes in order", async () => {
      const task = await store.create("Task");

      await store.addNote(task.id, "First note");
      await store.addNote(task.id, "Second note");
      await store.addNote(task.id, "Third note");

      const updated = await store.get(task.id);
      expect(updated?.notes).toHaveLength(3);
      expect(updated?.notes.map((n) => n.content)).toEqual([
        "First note",
        "Second note",
        "Third note",
      ]);
    });
  });

  describe("getReady", () => {
    it("returns open tasks with no deps", async () => {
      const task = await store.create("Ready task");

      const ready = await store.getReady();

      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(task.id);
    });

    it("excludes draft tasks", async () => {
      await store.create("Draft task", { status: "draft" });

      const ready = await store.getReady();

      expect(ready).toHaveLength(0);
    });

    it("excludes in_progress tasks", async () => {
      const task = await store.create("Task");
      await store.start(task.id);

      const ready = await store.getReady();

      expect(ready).toHaveLength(0);
    });

    it("excludes done tasks", async () => {
      const task = await store.create("Task");
      await store.close(task.id);

      const ready = await store.getReady();

      expect(ready).toHaveLength(0);
    });

    it("excludes tasks with unresolved deps", async () => {
      const dep = await store.create("Dependency");
      await store.create("Blocked task", { deps: [dep.id] });

      const ready = await store.getReady();

      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(dep.id);
    });

    it("includes tasks when all deps are done", async () => {
      const dep = await store.create("Dependency");
      const task = await store.create("Task", { deps: [dep.id] });
      await store.close(dep.id);

      const ready = await store.getReady();

      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe(task.id);
    });

    it("handles multiple deps correctly", async () => {
      const dep1 = await store.create("Dep 1");
      const dep2 = await store.create("Dep 2");
      const task = await store.create("Task", { deps: [dep1.id, dep2.id] });

      // Only one dep done - task not ready
      await store.close(dep1.id);
      let ready = await store.getReady();
      expect(ready.map((t) => t.id)).not.toContain(task.id);

      // Both deps done - task ready
      await store.close(dep2.id);
      ready = await store.getReady();
      expect(ready.map((t) => t.id)).toContain(task.id);
    });

    it("sorts by created date (oldest first) when no priority", async () => {
      const task1 = await store.create("Task 1");
      await new Promise((r) => setTimeout(r, 10));
      const task2 = await store.create("Task 2");
      await new Promise((r) => setTimeout(r, 10));
      const task3 = await store.create("Task 3");

      const ready = await store.getReady();

      expect(ready.map((t) => t.id)).toEqual([task1.id, task2.id, task3.id]);
    });

    it("sorts by priority first (lower number = higher priority)", async () => {
      // Create in wrong order to prove priority wins over creation time
      const low = await store.create("Low priority", { priority: 10 });
      const high = await store.create("High priority", { priority: 1 });
      const medium = await store.create("Medium priority", { priority: 5 });

      const ready = await store.getReady();

      expect(ready.map((t) => t.id)).toEqual([high.id, medium.id, low.id]);
    });

    it("tasks with priority come before tasks without", async () => {
      // Create without priority first to prove priority wins
      const noPriority = await store.create("No priority");
      const withPriority = await store.create("With priority", { priority: 5 });

      const ready = await store.getReady();

      expect(ready.map((t) => t.id)).toEqual([withPriority.id, noPriority.id]);
    });

    it("sorts by created date within same priority", async () => {
      const first = await store.create("First", { priority: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const second = await store.create("Second", { priority: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const third = await store.create("Third", { priority: 1 });

      const ready = await store.getReady();

      expect(ready.map((t) => t.id)).toEqual([first.id, second.id, third.id]);
    });

    describe("parent blocked by children", () => {
      it("excludes parent task when it has open children", async () => {
        const parent = await store.create("Parent task");
        await store.create("Child 1", { parentId: parent.id });
        await store.create("Child 2", { parentId: parent.id });

        const ready = await store.getReady();

        // Children are ready but parent is not (has open children)
        expect(ready).toHaveLength(2);
        expect(ready.map((t) => t.id)).not.toContain(parent.id);
      });

      it("includes parent task when all children are done", async () => {
        const parent = await store.create("Parent task");
        const child1 = await store.create("Child 1", { parentId: parent.id });
        const child2 = await store.create("Child 2", { parentId: parent.id });

        await store.close(child1.id);
        await store.close(child2.id);

        const ready = await store.getReady();

        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(parent.id);
      });

      it("excludes parent when some children are not done", async () => {
        const parent = await store.create("Parent task");
        const child1 = await store.create("Child 1", { parentId: parent.id });
        await store.create("Child 2", { parentId: parent.id });

        await store.close(child1.id);

        const ready = await store.getReady();

        // Only child2 is ready, parent is blocked by child2
        expect(ready).toHaveLength(1);
        expect(ready.map((t) => t.id)).not.toContain(parent.id);
      });

      it("handles nested children - parent waits for all descendants", async () => {
        const parent = await store.create("Parent");
        const child = await store.create("Child", { parentId: parent.id });
        const grandchild = await store.create("Grandchild", {
          parentId: child.id,
        });

        // Only grandchild is ready (no children)
        let ready = await store.getReady();
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(grandchild.id);

        // After grandchild done, child becomes ready
        await store.close(grandchild.id);
        ready = await store.getReady();
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(child.id);

        // After child done, parent becomes ready
        await store.close(child.id);
        ready = await store.getReady();
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(parent.id);
      });

      it("combines deps and children blocking", async () => {
        const dep = await store.create("Dependency");
        const parent = await store.create("Parent", { deps: [dep.id] });
        const child = await store.create("Child", { parentId: parent.id });

        // Only dep and child are ready (parent blocked by both dep and child)
        let ready = await store.getReady();
        expect(ready).toHaveLength(2);
        expect(ready.map((t) => t.id)).toContain(dep.id);
        expect(ready.map((t) => t.id)).toContain(child.id);
        expect(ready.map((t) => t.id)).not.toContain(parent.id);

        // Close child but not dep - parent still blocked
        await store.close(child.id);
        ready = await store.getReady();
        expect(ready.map((t) => t.id)).not.toContain(parent.id);

        // Close dep - now parent is ready
        await store.close(dep.id);
        ready = await store.getReady();
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(parent.id);
      });

      it("task with no children is ready (leaf task)", async () => {
        const task = await store.create("Leaf task");

        const ready = await store.getReady();

        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(task.id);
      });
    });

    describe("scoped to epic", () => {
      it("returns only ready tasks in epic children tree", async () => {
        await store.create("Unrelated task");
        const epic = await store.create("Epic");
        const child = await store.create("Epic child", { parentId: epic.id });

        const ready = await store.getReady(epic.id);

        // Only child is ready (epic blocked by its open child)
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(child.id);

        // After closing child, epic becomes ready
        await store.close(child.id);
        const readyAfter = await store.getReady(epic.id);
        expect(readyAfter).toHaveLength(1);
        expect(readyAfter[0].id).toBe(epic.id);
      });

      it("returns empty when epic and children are not ready", async () => {
        const epic = await store.create("Epic", { status: "draft" });
        await store.create("Child", { parentId: epic.id, status: "draft" });

        const ready = await store.getReady(epic.id);

        expect(ready).toHaveLength(0);
      });

      it("handles nested children", async () => {
        const epic = await store.create("Epic");
        const child = await store.create("Child", { parentId: epic.id });
        const grandchild = await store.create("Grandchild", {
          parentId: child.id,
        });

        // Only grandchild is ready (leaf node)
        let ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(grandchild.id);

        // After closing grandchild, child becomes ready
        await store.close(grandchild.id);
        ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(child.id);

        // After closing child, epic becomes ready
        await store.close(child.id);
        ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(epic.id);
      });
    });
  });

  describe("getBlocked", () => {
    it("returns tasks with unresolved deps", async () => {
      const dep = await store.create("Dependency");
      const blocked = await store.create("Blocked", { deps: [dep.id] });

      const result = await store.getBlocked();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(blocked.id);
    });

    it("excludes tasks with no deps", async () => {
      await store.create("No deps");

      const result = await store.getBlocked();

      expect(result).toHaveLength(0);
    });

    it("excludes tasks with all deps done", async () => {
      const dep = await store.create("Dep");
      await store.create("Task", { deps: [dep.id] });
      await store.close(dep.id);

      const result = await store.getBlocked();

      expect(result).toHaveLength(0);
    });

    it("excludes draft tasks", async () => {
      const dep = await store.create("Dep");
      await store.create("Draft blocked", { status: "draft", deps: [dep.id] });

      const result = await store.getBlocked();

      expect(result).toHaveLength(0);
    });

    it("includes in_progress tasks with unresolved deps", async () => {
      const dep = await store.create("Dep");
      const task = await store.create("Task", { deps: [dep.id] });
      // Force start even with unresolved deps (edge case)
      await store.update(task.id, { status: "in_progress" });

      const result = await store.getBlocked();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(task.id);
    });

    describe("scoped to epic", () => {
      it("returns only blocked tasks in epic children tree", async () => {
        const unrelatedDep = await store.create("Unrelated dep");
        await store.create("Unrelated blocked", {
          deps: [unrelatedDep.id],
        });

        const epic = await store.create("Epic");
        const externalDep = await store.create("External dep");
        const blockedChild = await store.create("Blocked child", {
          parentId: epic.id,
          deps: [externalDep.id],
        });

        const blocked = await store.getBlocked(epic.id);

        expect(blocked).toHaveLength(1);
        expect(blocked[0].id).toBe(blockedChild.id);
      });
    });
  });

  describe("getClosed", () => {
    it("returns done tasks", async () => {
      const task = await store.create("Task");
      await store.close(task.id);

      const closed = await store.getClosed();

      expect(closed).toHaveLength(1);
      expect(closed[0].id).toBe(task.id);
    });

    it("excludes non-done tasks", async () => {
      await store.create("Open task");
      await store.create("Draft task", { status: "draft" });
      const inProgress = await store.create("In progress");
      await store.start(inProgress.id);

      const closed = await store.getClosed();

      expect(closed).toHaveLength(0);
    });

    it("sorts by created date (most recent first)", async () => {
      const task1 = await store.create("Task 1");
      await new Promise((r) => setTimeout(r, 10));
      const task2 = await store.create("Task 2");
      await new Promise((r) => setTimeout(r, 10));
      const task3 = await store.create("Task 3");

      await store.close(task1.id);
      await store.close(task2.id);
      await store.close(task3.id);

      const closed = await store.getClosed();

      expect(closed.map((t) => t.id)).toEqual([task3.id, task2.id, task1.id]);
    });

    describe("scoped to epic", () => {
      it("returns only closed tasks in epic children tree", async () => {
        const unrelated = await store.create("Unrelated");
        await store.close(unrelated.id);

        const epic = await store.create("Epic");
        const child = await store.create("Epic child", { parentId: epic.id });
        await store.close(child.id);

        const closed = await store.getClosed(epic.id);

        // Only the closed child is returned (epic is still open)
        expect(closed).toHaveLength(1);
        expect(closed[0].id).toBe(child.id);
      });
    });
  });

  describe("getDepTree", () => {
    it("returns empty for task with no deps", async () => {
      const task = await store.create("Leaf task");

      const tree = await store.getDepTree(task.id);

      expect(tree).toEqual([]);
    });

    it("returns direct deps", async () => {
      const dep1 = await store.create("Dep 1");
      const dep2 = await store.create("Dep 2");
      const task = await store.create("Task", { deps: [dep1.id, dep2.id] });

      const tree = await store.getDepTree(task.id);

      expect(tree).toHaveLength(2);
      expect(tree.map((t) => t.id).sort()).toEqual([dep1.id, dep2.id].sort());
    });

    it("returns nested deps recursively", async () => {
      const leaf = await store.create("Leaf");
      const middle = await store.create("Middle", { deps: [leaf.id] });
      const root = await store.create("Root", { deps: [middle.id] });

      const tree = await store.getDepTree(root.id);

      expect(tree).toHaveLength(2);
      expect(tree.map((t) => t.id).sort()).toEqual([leaf.id, middle.id].sort());
    });

    it("handles diamond deps without duplicates", async () => {
      const shared = await store.create("Shared");
      const left = await store.create("Left", { deps: [shared.id] });
      const right = await store.create("Right", { deps: [shared.id] });
      const root = await store.create("Root", { deps: [left.id, right.id] });

      const tree = await store.getDepTree(root.id);

      expect(tree).toHaveLength(3);
      expect(tree.map((t) => t.id).sort()).toEqual(
        [shared.id, left.id, right.id].sort()
      );
    });

    it("handles circular deps gracefully", async () => {
      const task1 = await store.create("Task 1");
      const task2 = await store.create("Task 2", { deps: [task1.id] });
      await store.addDep(task1.id, task2.id); // create cycle

      // Should not infinite loop
      const tree = await store.getDepTree(task1.id);

      expect(tree.map((t) => t.id)).toContain(task2.id);
    });

    it("throws for non-existent task", async () => {
      await expect(store.getDepTree("nonexistent")).rejects.toThrow();
    });
  });

  describe("file persistence", () => {
    it("persists tasks across store instances", async () => {
      const task = await store.create("Persistent task", {
        body: "With body",
        assignee: "claude",
      });
      await store.addNote(task.id, "A note");

      // Create new store instance pointing to same dir
      const store2 = new FileTaskStore(tempDir);
      const retrieved = await store2.get(task.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Persistent task");
      expect(retrieved?.body).toBe("With body");
      expect(retrieved?.assignee).toBe("claude");
      expect(retrieved?.created).toBe(task.created);
      expect(retrieved?.notes).toHaveLength(1);
      expect(retrieved?.notes[0].content).toBe("A note");
    });

    it("persists parentId across store instances", async () => {
      const parent = await store.create("Parent");
      const child = await store.create("Child", { parentId: parent.id });

      const store2 = new FileTaskStore(tempDir);
      const retrieved = await store2.get(child.id);

      expect(retrieved?.parentId).toBe(parent.id);
    });

    it("persists priority across store instances", async () => {
      const task = await store.create("Priority task", { priority: 3 });

      const store2 = new FileTaskStore(tempDir);
      const retrieved = await store2.get(task.id);

      expect(retrieved?.priority).toBe(3);
    });

    it("persists raw content across store instances", async () => {
      const task = await store.create("Task with everything", {
        body: "Detailed body",
        acceptanceCriteria: ["tests pass", "build succeeds"],
        assignee: "claude",
        priority: 1,
      });
      await store.addNote(task.id, "Implementation note");

      const store2 = new FileTaskStore(tempDir);
      const retrieved = await store2.get(task.id);

      expect(retrieved?.raw).toContain("title: Task with everything");
      expect(retrieved?.raw).toContain("Detailed body");
      expect(retrieved?.raw).toContain("## Acceptance Criteria");
      expect(retrieved?.raw).toContain("tests pass");
      expect(retrieved?.raw).toContain("build succeeds");
      expect(retrieved?.raw).toContain("## Notes");
      expect(retrieved?.raw).toContain("Implementation note");
      expect(retrieved?.raw).toContain("assignee: claude");
      expect(retrieved?.raw).toContain("priority: 1");
    });
  });

  describe("parent-child hierarchy", () => {
    describe("getAncestors", () => {
      it("returns empty array for task with no parent", async () => {
        const task = await store.create("Root task");

        const ancestors = await store.getAncestors(task.id);

        expect(ancestors).toEqual([]);
      });

      it("returns parent for child task", async () => {
        const parent = await store.create("Parent");
        const child = await store.create("Child", { parentId: parent.id });

        const ancestors = await store.getAncestors(child.id);

        expect(ancestors).toHaveLength(1);
        expect(ancestors[0].id).toBe(parent.id);
      });

      it("returns full ancestor chain in order", async () => {
        const grandparent = await store.create("Grandparent");
        const parent = await store.create("Parent", {
          parentId: grandparent.id,
        });
        const child = await store.create("Child", { parentId: parent.id });

        const ancestors = await store.getAncestors(child.id);

        expect(ancestors).toHaveLength(2);
        expect(ancestors[0].id).toBe(parent.id);
        expect(ancestors[1].id).toBe(grandparent.id);
      });

      it("throws for non-existent task", async () => {
        await expect(store.getAncestors("nonexistent")).rejects.toThrow();
      });
    });

    describe("getChildren", () => {
      it("returns empty array for task with no children", async () => {
        const task = await store.create("Leaf task");

        const children = await store.getChildren(task.id);

        expect(children).toEqual([]);
      });

      it("returns direct children", async () => {
        const parent = await store.create("Parent");
        const child1 = await store.create("Child 1", { parentId: parent.id });
        const child2 = await store.create("Child 2", { parentId: parent.id });

        const children = await store.getChildren(parent.id);

        expect(children).toHaveLength(2);
        expect(children.map((c) => c.id).sort()).toEqual(
          [child1.id, child2.id].sort()
        );
      });

      it("does not return grandchildren", async () => {
        const grandparent = await store.create("Grandparent");
        const parent = await store.create("Parent", {
          parentId: grandparent.id,
        });
        await store.create("Grandchild", { parentId: parent.id });

        const children = await store.getChildren(grandparent.id);

        expect(children).toHaveLength(1);
        expect(children[0].id).toBe(parent.id);
      });

      it("sorts by priority first (lower number = higher priority)", async () => {
        const parent = await store.create("Parent");
        // Create in wrong order to prove priority wins over creation time
        const low = await store.create("Low priority child", {
          parentId: parent.id,
          priority: 10,
        });
        const high = await store.create("High priority child", {
          parentId: parent.id,
          priority: 1,
        });
        const medium = await store.create("Medium priority child", {
          parentId: parent.id,
          priority: 5,
        });

        const children = await store.getChildren(parent.id);

        expect(children.map((c) => c.id)).toEqual([high.id, medium.id, low.id]);
      });

      it("children with priority come before children without", async () => {
        const parent = await store.create("Parent");
        // Create without priority first to prove priority wins
        const noPriority = await store.create("No priority", {
          parentId: parent.id,
        });
        const withPriority = await store.create("With priority", {
          parentId: parent.id,
          priority: 5,
        });

        const children = await store.getChildren(parent.id);

        expect(children.map((c) => c.id)).toEqual([
          withPriority.id,
          noPriority.id,
        ]);
      });
    });

    describe("setParent", () => {
      it("sets parent on a task", async () => {
        const parent = await store.create("Parent");
        const task = await store.create("Task");

        await store.setParent(task.id, parent.id);

        const updated = await store.get(task.id);
        expect(updated?.parentId).toBe(parent.id);
      });

      it("removes parent when set to null", async () => {
        const parent = await store.create("Parent");
        const task = await store.create("Task", { parentId: parent.id });

        await store.setParent(task.id, null);

        const updated = await store.get(task.id);
        expect(updated?.parentId).toBeUndefined();
      });

      it("throws for non-existent task", async () => {
        const parent = await store.create("Parent");

        await expect(store.setParent("nonexistent", parent.id)).rejects.toThrow(
          "Task not found"
        );
      });

      it("throws for non-existent parent", async () => {
        const task = await store.create("Task");

        await expect(store.setParent(task.id, "nonexistent")).rejects.toThrow(
          "Parent task not found"
        );
      });

      it("throws when setting task as its own parent", async () => {
        const task = await store.create("Task");

        await expect(store.setParent(task.id, task.id)).rejects.toThrow(
          "Task cannot be its own parent"
        );
      });

      it("throws when creating circular reference", async () => {
        const parent = await store.create("Parent");
        const child = await store.create("Child", { parentId: parent.id });

        await expect(store.setParent(parent.id, child.id)).rejects.toThrow(
          "circular reference"
        );
      });
    });
  });
});
