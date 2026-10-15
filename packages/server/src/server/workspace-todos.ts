import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  WorkspaceTodosSchema,
  WorkspaceTodoMutationSchema,
  type WorkspaceTodos,
  type WorkspaceTodoMutation,
  type WorkspaceTodo,
} from "@getpaseo/protocol/workspace-todos";
import { writeJsonFileAtomic } from "./atomic-file.js";

export class WorkspaceTodosStore {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Map<string, Set<(list: WorkspaceTodos) => void>>();
  constructor(private readonly directory: string) {}

  private file(workspaceId: string): string {
    return path.join(this.directory, `${Buffer.from(workspaceId).toString("hex")}.json`);
  }
  async read(workspaceId: string): Promise<WorkspaceTodos> {
    await this.queue;
    return this.load(workspaceId);
  }
  private async load(workspaceId: string): Promise<WorkspaceTodos> {
    try {
      return WorkspaceTodosSchema.parse(
        JSON.parse(await fs.readFile(this.file(workspaceId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0, initialized: false, tasks: [] };
      throw error;
    }
  }
  subscribe(workspaceId: string, listener: (list: WorkspaceTodos) => void): () => void {
    const listeners = this.listeners.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(workspaceId);
    };
  }
  mutate(
    workspaceId: string,
    revision: number,
    mutation: WorkspaceTodoMutation,
    actor: "user" | "agent",
  ): Promise<WorkspaceTodos> {
    const result = this.queue.then(async () => {
      const parsed = WorkspaceTodoMutationSchema.parse(mutation);
      const list = await this.load(workspaceId);
      if (list.revision !== revision)
        throw new Error("To-do revision conflict; read the list again before retrying");
      applyMutation(list, parsed, actor);
      list.initialized = true;
      list.revision++;
      WorkspaceTodosSchema.parse(list);
      await writeJsonFileAtomic(this.file(workspaceId), list);
      for (const listener of this.listeners.get(workspaceId) ?? []) listener(structuredClone(list));
      return list;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// Sessions and agent tools share the same mutation queue and committed observations.
const stores = new Map<string, WorkspaceTodosStore>();
export function workspaceTodosForHome(paseoHome: string): WorkspaceTodosStore {
  const directory = path.join(paseoHome, "projects", "todos");
  let store = stores.get(directory);
  if (!store) {
    store = new WorkspaceTodosStore(directory);
    stores.set(directory, store);
  }
  return store;
}

function applyMutation(
  list: WorkspaceTodos,
  mutation: WorkspaceTodoMutation,
  actor: "user" | "agent",
): void {
  const newTask = (text: { title: string; notes: string; milestone?: string }) => ({
    ...text,
    milestone: text.milestone?.trim(),
    milestoneProtected: actor === "user" && Boolean(text.milestone?.trim()),
    id: randomUUID(),
    status: "todo" as const,
    titleProtected: actor === "user",
    notesProtected: actor === "user",
  });
  switch (mutation.operation) {
    case "initialize":
      if (list.initialized) throw new Error("To-do list already initialized; reuse existing tasks");
      list.tasks = mutation.tasks.map(newTask);
      break;
    case "add":
      list.tasks.push(
        newTask({ title: mutation.title, notes: mutation.notes, milestone: mutation.milestone }),
      );
      break;
    case "reorder": {
      if (
        mutation.ids.length !== list.tasks.length ||
        new Set(mutation.ids).size !== list.tasks.length
      )
        throw new Error("Order must contain each task exactly once");
      const tasks = new Map(list.tasks.map((task) => [task.id, task]));
      list.tasks = mutation.ids.map((id) => {
        const task = tasks.get(id);
        if (!task) throw new Error("Unknown task");
        return task;
      });
      break;
    }
    case "delete":
    case "update": {
      const id = mutation.id;
      const task = list.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Unknown task");
      if (mutation.operation === "delete") {
        if (
          actor === "agent" &&
          (task.titleProtected || task.notesProtected || task.milestoneProtected)
        )
          throw new Error("Manually edited task cannot be deleted by an agent");
        list.tasks = list.tasks.filter((item) => item.id !== task.id);
      } else {
        updateTask(task, mutation, actor);
      }
      break;
    }
  }
}

function updateTask(
  task: WorkspaceTodo,
  mutation: Extract<WorkspaceTodoMutation, { operation: "update" }>,
  actor: "user" | "agent",
): void {
  if (
    actor === "agent" &&
    ((mutation.title !== undefined && task.titleProtected) ||
      (mutation.notes !== undefined && task.notesProtected) ||
      (mutation.milestone !== undefined && task.milestoneProtected))
  )
    throw new Error("Manually edited text is protected");
  if (mutation.title !== undefined) {
    task.title = mutation.title;
    task.titleProtected ||= actor === "user";
  }
  if (mutation.notes !== undefined) {
    task.notes = mutation.notes;
    task.notesProtected ||= actor === "user";
  }
  if (mutation.milestone !== undefined) {
    task.milestone = mutation.milestone.trim();
    task.milestoneProtected ||= actor === "user";
  }
  if (mutation.status !== undefined) task.status = mutation.status;
}
