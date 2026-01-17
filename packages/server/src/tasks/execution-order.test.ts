import { describe, it, expect, beforeEach } from "vitest";
import { computeExecutionOrder, buildSortedChildrenMap } from "./execution-order.js";
import type { Task, TaskStore } from "./types.js";

/**
 * In-memory task store for testing
 */
class MemoryTaskStore implements TaskStore {
  private tasks: Map<string, Task> = new Map();

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  async list(): Promise<Task[]> {
    return [...this.tasks.values()];
  }

  async get(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }

  async getDescendants(id: string): Promise<Task[]> {
    const result: Task[] = [];
    const traverse = (parentId: string): void => {
      for (const task of this.tasks.values()) {
        if (task.parentId === parentId) {
          result.push(task);
          traverse(task.id);
        }
      }
    };
    traverse(id);
    return result;
  }

  // Unused in tests but required by interface
  async getDepTree(): Promise<Task[]> {
    return [];
  }
  async getAncestors(): Promise<Task[]> {
    return [];
  }
  async getChildren(id: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => t.parentId === id);
  }
  async getReady(): Promise<Task[]> {
    return [];
  }
  async getBlocked(): Promise<Task[]> {
    return [];
  }
  async getClosed(): Promise<Task[]> {
    return [];
  }
  async create(): Promise<Task> {
    throw new Error("Not implemented");
  }
  async update(): Promise<Task> {
    throw new Error("Not implemented");
  }
  async delete(): Promise<void> {
    throw new Error("Not implemented");
  }
  async addDep(): Promise<void> {
    throw new Error("Not implemented");
  }
  async removeDep(): Promise<void> {
    throw new Error("Not implemented");
  }
  async setParent(): Promise<void> {
    throw new Error("Not implemented");
  }
  async addNote(): Promise<void> {
    throw new Error("Not implemented");
  }
  async open(): Promise<void> {
    throw new Error("Not implemented");
  }
  async start(): Promise<void> {
    throw new Error("Not implemented");
  }
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }
  async fail(): Promise<void> {
    throw new Error("Not implemented");
  }
  async addAcceptanceCriteria(): Promise<void> {
    throw new Error("Not implemented");
  }
}

function makeTask(
  id: string,
  opts: {
    title?: string;
    status?: Task["status"];
    parentId?: string;
    deps?: string[];
    priority?: number;
    created?: string;
  } = {}
): Task {
  return {
    id,
    title: opts.title ?? id,
    status: opts.status ?? "open",
    parentId: opts.parentId,
    deps: opts.deps ?? [],
    priority: opts.priority,
    created: opts.created ?? new Date().toISOString(),
    body: "",
    acceptanceCriteria: [],
    notes: [],
  };
}

describe("computeExecutionOrder", () => {
  let store: MemoryTaskStore;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  it("should return empty timeline for empty store", async () => {
    const result = await computeExecutionOrder(store);
    expect(result.timeline).toEqual([]);
    expect(result.orderMap.size).toBe(0);
    expect(result.blocked.size).toBe(0);
  });

  it("should order by priority (lower number first)", async () => {
    store.addTask(makeTask("a", { priority: 2, created: "2024-01-01" }));
    store.addTask(makeTask("b", { priority: 0, created: "2024-01-02" }));
    store.addTask(makeTask("c", { priority: 1, created: "2024-01-03" }));

    const result = await computeExecutionOrder(store);
    const ids = result.timeline.map((t) => t.id);

    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("should order tasks without priority after prioritized tasks", async () => {
    store.addTask(makeTask("a", { created: "2024-01-01" })); // no priority
    store.addTask(makeTask("b", { priority: 1, created: "2024-01-02" }));
    store.addTask(makeTask("c", { created: "2024-01-03" })); // no priority

    const result = await computeExecutionOrder(store);
    const ids = result.timeline.map((t) => t.id);

    // b first (has priority), then a and c by created date
    expect(ids).toEqual(["b", "a", "c"]);
  });

  it("should respect dependencies", async () => {
    // c depends on b
    store.addTask(makeTask("a", { created: "2024-01-01" }));
    store.addTask(makeTask("b", { created: "2024-01-02" }));
    store.addTask(makeTask("c", { deps: ["b"], created: "2024-01-03" }));

    const result = await computeExecutionOrder(store);
    const ids = result.timeline.map((t) => t.id);

    // a and b can run (a first by created), then c after b
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("should execute children before parent", async () => {
    // Parent b has children b1 and b2
    store.addTask(makeTask("b", { created: "2024-01-01" }));
    store.addTask(makeTask("b1", { parentId: "b", created: "2024-01-02" }));
    store.addTask(makeTask("b2", { parentId: "b", created: "2024-01-03" }));

    const result = await computeExecutionOrder(store, "b");
    const ids = result.timeline.map((t) => t.id);

    // Children first, then parent
    expect(ids).toEqual(["b1", "b2", "b"]);
  });

  it("should handle complex epic with phases and dependencies", async () => {
    /**
     * Epic structure:
     *
     * epic (root)
     * ├── phase1 (priority 0)
     * │   ├── p1-task1
     * │   └── p1-task2 (depends on p1-task1)
     * ├── phase2 (depends on phase1)
     * │   ├── p2-task1
     * │   └── p2-task2
     * └── cleanup (no priority, depends on phase2)
     */

    // Epic root
    store.addTask(makeTask("epic", { created: "2024-01-01" }));

    // Phase 1 - priority 0 (should run first)
    store.addTask(
      makeTask("phase1", {
        parentId: "epic",
        priority: 0,
        created: "2024-01-02",
      })
    );
    store.addTask(
      makeTask("p1-task1", { parentId: "phase1", created: "2024-01-03" })
    );
    store.addTask(
      makeTask("p1-task2", {
        parentId: "phase1",
        deps: ["p1-task1"],
        created: "2024-01-04",
      })
    );

    // Phase 2 - depends on phase1
    store.addTask(
      makeTask("phase2", {
        parentId: "epic",
        deps: ["phase1"],
        created: "2024-01-05",
      })
    );
    store.addTask(
      makeTask("p2-task1", { parentId: "phase2", created: "2024-01-06" })
    );
    store.addTask(
      makeTask("p2-task2", { parentId: "phase2", created: "2024-01-07" })
    );

    // Cleanup - no priority, depends on phase2
    store.addTask(
      makeTask("cleanup", {
        parentId: "epic",
        deps: ["phase2"],
        created: "2024-01-08",
      })
    );

    const result = await computeExecutionOrder(store, "epic");
    const ids = result.timeline.map((t) => t.id);

    // Expected order:
    // 1. p1-task1 (leaf, no deps)
    // 2. p1-task2 (leaf, deps on p1-task1)
    // 3. phase1 (parent, children done)
    // 4. p2-task1, p2-task2 (leaves, phase1 done)
    // 5. phase2 (parent, children done, dep on phase1 done)
    // 6. cleanup (dep on phase2 done)
    // 7. epic (all children done)

    expect(ids).toEqual([
      "p1-task1",
      "p1-task2",
      "phase1",
      "p2-task1",
      "p2-task2",
      "phase2",
      "cleanup",
      "epic",
    ]);
  });

  it("should handle priority override within same parent", async () => {
    /**
     * Parent with children where priority overrides created order:
     *
     * parent
     * ├── child-a (no priority, created first)
     * ├── child-b (priority 0, created second) <- should run first
     * └── child-c (priority 1, created third)
     */

    store.addTask(makeTask("parent", { created: "2024-01-01" }));
    store.addTask(
      makeTask("child-a", { parentId: "parent", created: "2024-01-02" })
    );
    store.addTask(
      makeTask("child-b", {
        parentId: "parent",
        priority: 0,
        created: "2024-01-03",
      })
    );
    store.addTask(
      makeTask("child-c", {
        parentId: "parent",
        priority: 1,
        created: "2024-01-04",
      })
    );

    const result = await computeExecutionOrder(store, "parent");
    const ids = result.timeline.map((t) => t.id);

    // b first (priority 0), c second (priority 1), a last (no priority), then parent
    expect(ids).toEqual(["child-b", "child-c", "child-a", "parent"]);
  });

  it("should place done tasks first in historical order", async () => {
    store.addTask(
      makeTask("done-later", { status: "done", created: "2024-01-03" })
    );
    store.addTask(
      makeTask("done-first", { status: "done", created: "2024-01-01" })
    );
    store.addTask(makeTask("pending", { created: "2024-01-02" }));

    const result = await computeExecutionOrder(store);
    const ids = result.timeline.map((t) => t.id);

    // Done tasks first (by created), then pending
    expect(ids).toEqual(["done-first", "done-later", "pending"]);
  });

  it("should mark tasks with unresolvable deps as blocked", async () => {
    // b depends on external-dep which doesn't exist in scope
    store.addTask(makeTask("a", { created: "2024-01-01" }));
    store.addTask(
      makeTask("b", { deps: ["external-dep"], created: "2024-01-02" })
    );

    const result = await computeExecutionOrder(store);

    expect(result.timeline.map((t) => t.id)).toEqual(["a"]);
    expect(result.blocked.has("b")).toBe(true);
  });

  it("should detect circular dependencies as blocked", async () => {
    // a depends on b, b depends on a
    store.addTask(makeTask("a", { deps: ["b"], created: "2024-01-01" }));
    store.addTask(makeTask("b", { deps: ["a"], created: "2024-01-02" }));

    const result = await computeExecutionOrder(store);

    expect(result.timeline).toEqual([]);
    expect(result.blocked.has("a")).toBe(true);
    expect(result.blocked.has("b")).toBe(true);
  });

  it("should handle in_progress tasks same as open", async () => {
    store.addTask(makeTask("a", { status: "in_progress", created: "2024-01-01" }));
    store.addTask(makeTask("b", { status: "open", created: "2024-01-02" }));

    const result = await computeExecutionOrder(store);
    const ids = result.timeline.map((t) => t.id);

    expect(ids).toEqual(["a", "b"]);
  });
});

describe("buildSortedChildrenMap", () => {
  it("should sort children by execution order", () => {
    const tasks: Task[] = [
      makeTask("parent"),
      makeTask("child-a", { parentId: "parent" }),
      makeTask("child-b", { parentId: "parent" }),
      makeTask("child-c", { parentId: "parent" }),
    ];

    // Execution order: child-c (0), child-a (1), child-b (2)
    const orderMap = new Map<string, number>([
      ["child-c", 0],
      ["child-a", 1],
      ["child-b", 2],
      ["parent", 3],
    ]);

    const childrenMap = buildSortedChildrenMap(tasks, orderMap);
    const children = childrenMap.get("parent")!;

    expect(children.map((t) => t.id)).toEqual(["child-c", "child-a", "child-b"]);
  });

  it("should handle tasks not in order map (put at end)", () => {
    const tasks: Task[] = [
      makeTask("parent"),
      makeTask("child-a", { parentId: "parent" }),
      makeTask("child-b", { parentId: "parent" }),
    ];

    // Only child-b in order map
    const orderMap = new Map<string, number>([["child-b", 0]]);

    const childrenMap = buildSortedChildrenMap(tasks, orderMap);
    const children = childrenMap.get("parent")!;

    // child-b first (has order), child-a last (Infinity)
    expect(children.map((t) => t.id)).toEqual(["child-b", "child-a"]);
  });
});
