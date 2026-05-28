import { readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Task, TaskStore, CreateTaskOptions } from "./types.js";
import {
  isBlockedTask,
  isReadyTask,
  loadScopedTaskGraph,
  sortByPriorityThenCreated,
} from "./task-graph.js";
import { readTaskDocument, writeTaskDocument } from "./task-document.js";

function generateId(): string {
  return randomBytes(4).toString("hex");
}

export class FileTaskStore implements TaskStore {
  constructor(private readonly dir: string) {}

  private taskPath(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readTask(id: string): Promise<Task | null> {
    try {
      return await readTaskDocument(this.taskPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeTask(task: Task): Promise<void> {
    await this.ensureDir();
    await writeTaskDocument(this.taskPath(task.id), task);
  }

  async list(): Promise<Task[]> {
    await this.ensureDir();
    try {
      const files = await readdir(this.dir);
      const ids = files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));
      const loaded = await Promise.all(ids.map((id) => this.readTask(id)));
      const tasks: Task[] = loaded.filter((task): task is Task => task !== null);
      // Sort by created date (oldest first) for consistent ordering
      return tasks.sort((a, b) => a.created.localeCompare(b.created));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async get(id: string): Promise<Task | null> {
    return this.readTask(id);
  }

  async getDepTree(id: string): Promise<Task[]> {
    const root = await this.get(id);
    if (!root) {
      throw new Error(`Task not found: ${id}`);
    }

    const visited = new Set<string>();
    const result: Task[] = [];

    const traverse = async (taskId: string): Promise<void> => {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const task = await this.get(taskId);
      if (!task) return;

      for (const depId of task.deps) {
        if (!visited.has(depId)) {
          const dep = await this.get(depId);
          if (dep) {
            result.push(dep);
            await traverse(depId);
          }
        }
      }
    };

    await traverse(id);
    return result;
  }

  async getAncestors(id: string): Promise<Task[]> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const ancestors: Task[] = [];
    let currentId = task.parentId;

    while (currentId) {
      const parent = await this.get(currentId);
      if (!parent) break;
      ancestors.push(parent);
      currentId = parent.parentId;
    }

    return ancestors;
  }

  async getChildren(id: string): Promise<Task[]> {
    const allTasks = await this.list();
    return allTasks.filter((t) => t.parentId === id).sort(sortByPriorityThenCreated);
  }

  async getDescendants(id: string): Promise<Task[]> {
    const result: Task[] = [];
    const traverse = async (parentId: string): Promise<void> => {
      const children = await this.getChildren(parentId);
      for (const child of children) {
        result.push(child);
        await traverse(child.id);
      }
    };
    await traverse(id);
    return result;
  }

  async getReady(scopeId?: string): Promise<Task[]> {
    const graph = await loadScopedTaskGraph(this, scopeId);
    return graph.candidates
      .filter((task) => isReadyTask(graph, task))
      .sort(sortByPriorityThenCreated);
  }

  async getBlocked(scopeId?: string): Promise<Task[]> {
    const graph = await loadScopedTaskGraph(this, scopeId);
    return graph.candidates.filter((task) => isBlockedTask(graph, task));
  }

  async getClosed(scopeId?: string): Promise<Task[]> {
    const { candidates } = await loadScopedTaskGraph(this, scopeId);

    return candidates
      .filter((t) => t.status === "done")
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  async create(title: string, opts?: CreateTaskOptions): Promise<Task> {
    // Validate parent exists if provided
    if (opts?.parentId) {
      const parent = await this.get(opts.parentId);
      if (!parent) {
        throw new Error(`Parent task not found: ${opts.parentId}`);
      }
    }

    const task: Task = {
      id: generateId(),
      title,
      status: opts?.status ?? "open",
      deps: opts?.deps ?? [],
      parentId: opts?.parentId,
      body: opts?.body ?? "",
      acceptanceCriteria: opts?.acceptanceCriteria ?? [],
      notes: [],
      created: new Date().toISOString(),
      assignee: opts?.assignee,
      priority: opts?.priority,
      raw: "", // will be set after serialization
    };

    await this.writeTask(task);
    // Re-read to get the raw content
    const saved = await this.get(task.id);
    return saved!;
  }

  async update(id: string, changes: Partial<Omit<Task, "id" | "created">>): Promise<Task> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const updated: Task = { ...task, ...changes };
    await this.writeTask(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await unlink(this.taskPath(id));
  }

  async addDep(id: string, depId: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const dep = await this.get(depId);
    if (!dep) {
      throw new Error(`Dependency not found: ${depId}`);
    }

    if (!task.deps.includes(depId)) {
      task.deps.push(depId);
      await this.writeTask(task);
    }
  }

  async removeDep(id: string, depId: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.deps = task.deps.filter((d) => d !== depId);
    await this.writeTask(task);
  }

  async setParent(id: string, parentId: string | null): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    if (parentId) {
      const parent = await this.get(parentId);
      if (!parent) {
        throw new Error(`Parent task not found: ${parentId}`);
      }
      // Prevent circular reference
      if (parentId === id) {
        throw new Error("Task cannot be its own parent");
      }
      // Check that the new parent isn't a descendant of this task
      const ancestors = await this.getAncestorsFrom(parentId);
      if (ancestors.some((a) => a.id === id)) {
        throw new Error("Cannot set parent: would create circular reference");
      }
    }

    await this.update(id, { parentId: parentId ?? undefined });
  }

  private async getAncestorsFrom(id: string): Promise<Task[]> {
    const ancestors: Task[] = [];
    let currentId: string | undefined = id;

    while (currentId) {
      const task = await this.get(currentId);
      if (!task) break;
      ancestors.push(task);
      currentId = task.parentId;
    }

    return ancestors;
  }

  async addNote(id: string, content: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.notes.push({
      timestamp: new Date().toISOString(),
      content,
    });
    await this.writeTask(task);
  }

  async open(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.update(id, { status: "open" });
  }

  async start(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (task.status !== "open") {
      throw new Error(`Cannot start task with status: ${task.status}`);
    }
    await this.update(id, { status: "in_progress" });
  }

  async close(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.update(id, { status: "done" });
  }

  async fail(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    await this.update(id, { status: "failed" });
  }

  async addAcceptanceCriteria(id: string, criterion: string): Promise<void> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    task.acceptanceCriteria.push(criterion);
    await this.writeTask(task);
  }
}
