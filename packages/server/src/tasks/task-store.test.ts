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
      expect(task.description).toBe("");
      expect(task.notes).toEqual([]);
      expect(task.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task.assignee).toBeUndefined();
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

    it("creates a task with description", async () => {
      const task = await store.create("Task with desc", {
        description: "This is a **long** description\n\nWith multiple lines.",
      });

      expect(task.description).toBe(
        "This is a **long** description\n\nWith multiple lines."
      );
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

    it("updates task description", async () => {
      const task = await store.create("Task");
      const updated = await store.update(task.id, {
        description: "New description",
      });

      expect(updated.description).toBe("New description");
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
  });

  describe("status transitions", () => {
    describe("open", () => {
      it("transitions draft to open", async () => {
        const task = await store.create("Draft", { status: "draft" });
        await store.open(task.id);

        const updated = await store.get(task.id);
        expect(updated?.status).toBe("open");
      });

      it("throws when task is not draft", async () => {
        const task = await store.create("Open task", { status: "open" });

        await expect(store.open(task.id)).rejects.toThrow();
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

    it("sorts by created date (oldest first)", async () => {
      const task1 = await store.create("Task 1");
      await new Promise((r) => setTimeout(r, 10));
      const task2 = await store.create("Task 2");
      await new Promise((r) => setTimeout(r, 10));
      const task3 = await store.create("Task 3");

      const ready = await store.getReady();

      expect(ready.map((t) => t.id)).toEqual([task1.id, task2.id, task3.id]);
    });

    describe("scoped to epic", () => {
      it("returns only ready tasks in epic dep tree", async () => {
        await store.create("Unrelated task");
        const dep = await store.create("Epic dep");
        const epic = await store.create("Epic", { deps: [dep.id] });

        const ready = await store.getReady(epic.id);

        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(dep.id);
      });

      it("returns empty when epic has no ready deps", async () => {
        const dep = await store.create("Dep", { status: "draft" });
        const epic = await store.create("Epic", { deps: [dep.id] });

        const ready = await store.getReady(epic.id);

        expect(ready).toHaveLength(0);
      });

      it("handles nested deps", async () => {
        const leaf = await store.create("Leaf");
        const middle = await store.create("Middle", { deps: [leaf.id] });
        const epic = await store.create("Epic", { deps: [middle.id] });

        // Only leaf is ready initially
        let ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(leaf.id);

        // After leaf done, middle is ready
        await store.close(leaf.id);
        ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(middle.id);

        // After middle done, epic itself is ready (but we're scoped, so epic not in results)
        await store.close(middle.id);
        ready = await store.getReady(epic.id);
        expect(ready).toHaveLength(0);
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
      it("returns only blocked tasks in epic dep tree", async () => {
        const unrelatedDep = await store.create("Unrelated dep");
        await store.create("Unrelated blocked", {
          deps: [unrelatedDep.id],
        });

        const epicDep = await store.create("Epic dep");
        const epicChild = await store.create("Epic child", {
          deps: [epicDep.id],
        });
        const epic = await store.create("Epic", { deps: [epicChild.id] });

        const blocked = await store.getBlocked(epic.id);

        expect(blocked).toHaveLength(1);
        expect(blocked[0].id).toBe(epicChild.id);
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
      it("returns only closed tasks in epic dep tree", async () => {
        const unrelated = await store.create("Unrelated");
        await store.close(unrelated.id);

        const dep = await store.create("Epic dep");
        const epic = await store.create("Epic", { deps: [dep.id] });
        await store.close(dep.id);

        const closed = await store.getClosed(epic.id);

        expect(closed).toHaveLength(1);
        expect(closed[0].id).toBe(dep.id);
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
        description: "With description",
        assignee: "claude",
      });
      await store.addNote(task.id, "A note");

      // Create new store instance pointing to same dir
      const store2 = new FileTaskStore(tempDir);
      const retrieved = await store2.get(task.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Persistent task");
      expect(retrieved?.description).toBe("With description");
      expect(retrieved?.assignee).toBe("claude");
      expect(retrieved?.created).toBe(task.created);
      expect(retrieved?.notes).toHaveLength(1);
      expect(retrieved?.notes[0].content).toBe("A note");
    });
  });
});
