import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  Task,
  TaskStore,
  CreateTaskOptions,
  TaskStatus,
  AgentType,
} from "./types.js";

function generateId(): string {
  return randomBytes(4).toString("hex");
}

function serializeTask(task: Task): string {
  const frontmatterLines = [
    "---",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `deps: [${task.deps.join(", ")}]`,
    `created: ${task.created}`,
  ];

  if (task.parentId) {
    frontmatterLines.push(`parentId: ${task.parentId}`);
  }

  if (task.assignee) {
    frontmatterLines.push(`assignee: ${task.assignee}`);
  }

  frontmatterLines.push("---");

  const frontmatter = frontmatterLines.join("\n");

  let content = "";
  if (task.body) {
    content += task.body + "\n";
  }

  if (task.acceptanceCriteria.length > 0) {
    content += "\n## Acceptance Criteria\n\n";
    for (const criterion of task.acceptanceCriteria) {
      content += `- [ ] ${criterion}\n`;
    }
  }

  if (task.notes.length > 0) {
    content += "\n## Notes\n";
    for (const note of task.notes) {
      content += `\n**${note.timestamp}**\n\n${note.content}\n`;
    }
  }

  return frontmatter + "\n\n" + content;
}

function parseTask(content: string): Task {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error("Invalid task file: missing frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const fileBody = content.slice(frontmatterMatch[0].length);

  const getValue = (key: string): string => {
    const match = frontmatter.match(new RegExp(`^${key}: (.*)$`, "m"));
    return match ? match[1] : "";
  };

  const depsStr = getValue("deps");
  const depsMatch = depsStr.match(/\[(.*)\]/);
  const deps =
    depsMatch && depsMatch[1].trim()
      ? depsMatch[1]
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : [];

  // Parse notes from body
  const notes: Task["notes"] = [];
  const notesSection = fileBody.match(/## Notes\n([\s\S]*?)$/);
  if (notesSection) {
    const noteMatches = notesSection[1].matchAll(
      /\*\*(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\*\*\n\n([\s\S]*?)(?=\n\*\*\d{4}|$)/g
    );
    for (const match of noteMatches) {
      notes.push({
        timestamp: match[1],
        content: match[2].trim(),
      });
    }
  }

  // Parse acceptance criteria
  const acceptanceCriteria: string[] = [];
  const criteriaSection = fileBody.match(
    /## Acceptance Criteria\n\n([\s\S]*?)(?=\n## Notes|$)/
  );
  if (criteriaSection) {
    const criteriaMatches = criteriaSection[1].matchAll(
      /- \[[ x]\] (.+)$/gm
    );
    for (const match of criteriaMatches) {
      acceptanceCriteria.push(match[1].trim());
    }
  }

  // Body is everything before ## Acceptance Criteria or ## Notes
  let taskBody = fileBody;
  const firstSection = fileBody.match(/\n## (Acceptance Criteria|Notes)\n/);
  if (firstSection) {
    taskBody = fileBody.slice(0, firstSection.index).trim();
  }
  taskBody = taskBody.trim();

  const assignee = getValue("assignee") as AgentType | "";
  const parentId = getValue("parentId");

  return {
    id: getValue("id"),
    title: getValue("title"),
    status: getValue("status") as TaskStatus,
    deps,
    parentId: parentId || undefined,
    body: taskBody,
    acceptanceCriteria,
    notes,
    created: getValue("created") || new Date().toISOString(),
    assignee: assignee || undefined,
  };
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
      const content = await readFile(this.taskPath(id), "utf-8");
      return parseTask(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeTask(task: Task): Promise<void> {
    await this.ensureDir();
    await writeFile(this.taskPath(task.id), serializeTask(task), "utf-8");
  }

  async list(): Promise<Task[]> {
    await this.ensureDir();
    try {
      const files = await readdir(this.dir);
      const tasks: Task[] = [];
      for (const file of files) {
        if (file.endsWith(".md")) {
          const id = file.slice(0, -3);
          const task = await this.readTask(id);
          if (task) {
            tasks.push(task);
          }
        }
      }
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
    return allTasks
      .filter((t) => t.parentId === id)
      .sort((a, b) => a.created.localeCompare(b.created));
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
    const allTasks = await this.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    let candidates: Task[];
    if (scopeId) {
      // Include the scoped task itself and all its descendants (children tree)
      const scopeTask = await this.get(scopeId);
      const descendants = await this.getDescendants(scopeId);
      candidates = scopeTask ? [scopeTask, ...descendants] : descendants;
    } else {
      candidates = allTasks;
    }

    // Build children map for quick lookup
    const childrenMap = new Map<string, Task[]>();
    for (const t of allTasks) {
      if (t.parentId) {
        const siblings = childrenMap.get(t.parentId) ?? [];
        siblings.push(t);
        childrenMap.set(t.parentId, siblings);
      }
    }

    const isReady = (task: Task): boolean => {
      if (task.status !== "open") return false;
      // All deps must be done
      const depsReady = task.deps.every((depId) => {
        const dep = taskMap.get(depId);
        return dep?.status === "done";
      });
      if (!depsReady) return false;
      // All children must be done (if any exist)
      const children = childrenMap.get(task.id) ?? [];
      return children.every((c) => c.status === "done");
    };

    // Sort by created date (oldest first) for consistent ordering
    return candidates.filter(isReady).sort((a, b) => {
      return a.created.localeCompare(b.created);
    });
  }

  async getBlocked(scopeId?: string): Promise<Task[]> {
    const allTasks = await this.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    let candidates: Task[];
    if (scopeId) {
      const scopeTask = await this.get(scopeId);
      const descendants = await this.getDescendants(scopeId);
      candidates = scopeTask ? [scopeTask, ...descendants] : descendants;
    } else {
      candidates = allTasks;
    }

    const isBlocked = (task: Task): boolean => {
      if (task.status === "draft" || task.status === "done") return false;
      if (task.deps.length === 0) return false;
      return task.deps.some((depId) => {
        const dep = taskMap.get(depId);
        return dep?.status !== "done";
      });
    };

    return candidates.filter(isBlocked);
  }

  async getClosed(scopeId?: string): Promise<Task[]> {
    let candidates: Task[];
    if (scopeId) {
      const scopeTask = await this.get(scopeId);
      const descendants = await this.getDescendants(scopeId);
      candidates = scopeTask ? [scopeTask, ...descendants] : descendants;
    } else {
      candidates = await this.list();
    }

    // Sort by created date (most recent first) for consistent ordering
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
    };

    await this.writeTask(task);
    return task;
  }

  async update(
    id: string,
    changes: Partial<Omit<Task, "id" | "created">>
  ): Promise<Task> {
    const task = await this.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const updated: Task = { ...task, ...changes };
    await this.writeTask(updated);
    return updated;
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
    if (task.status !== "draft") {
      throw new Error(`Cannot open task with status: ${task.status}`);
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
