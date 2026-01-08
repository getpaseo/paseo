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

  if (task.assignee) {
    frontmatterLines.push(`assignee: ${task.assignee}`);
  }

  frontmatterLines.push("---");

  const frontmatter = frontmatterLines.join("\n");

  let body = "";
  if (task.description) {
    body += task.description + "\n";
  }

  if (task.notes.length > 0) {
    body += "\n## Notes\n";
    for (const note of task.notes) {
      body += `\n**${note.timestamp}**\n\n${note.content}\n`;
    }
  }

  return frontmatter + "\n\n" + body;
}

function parseTask(content: string): Task {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error("Invalid task file: missing frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length);

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
  const notesSection = body.match(/## Notes\n([\s\S]*?)$/);
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

  // Description is everything before ## Notes
  let description = body;
  if (notesSection) {
    description = body.slice(0, body.indexOf("## Notes")).trim();
  }
  description = description.trim();

  const assignee = getValue("assignee") as AgentType | "";

  return {
    id: getValue("id"),
    title: getValue("title"),
    status: getValue("status") as TaskStatus,
    deps,
    description,
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
      return tasks;
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

  async getReady(scopeId?: string): Promise<Task[]> {
    const allTasks = await this.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    let candidates: Task[];
    if (scopeId) {
      const tree = await this.getDepTree(scopeId);
      candidates = tree;
    } else {
      candidates = allTasks;
    }

    const isReady = (task: Task): boolean => {
      if (task.status !== "open") return false;
      return task.deps.every((depId) => {
        const dep = taskMap.get(depId);
        return dep?.status === "done";
      });
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
      const tree = await this.getDepTree(scopeId);
      candidates = tree;
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
      const tree = await this.getDepTree(scopeId);
      candidates = tree;
    } else {
      candidates = await this.list();
    }

    // Sort by created date (most recent first) for closed tasks
    return candidates
      .filter((t) => t.status === "done")
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  async create(title: string, opts?: CreateTaskOptions): Promise<Task> {
    const task: Task = {
      id: generateId(),
      title,
      status: opts?.status ?? "open",
      deps: opts?.deps ?? [],
      description: opts?.description ?? "",
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
}
