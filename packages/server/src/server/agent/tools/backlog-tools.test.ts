import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKLOG_PROJECT_ID_LABEL, BACKLOG_TASK_ID_LABEL } from "@getpaseo/protocol/tasks/prompt";
import { TaskStore } from "../../tasks/task-store.js";
import {
  mergeBacklogIntoCreateAgentPrompt,
  registerBacklogTools,
  resolveBacklogLinkForAgentCreate,
} from "./backlog-tools.js";
import type { PaseoToolCatalog, PaseoToolConfig, PaseoToolDefinition } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-backlog-tools-"));
  tempDirs.push(dir);
  return dir;
}

function createCatalog(input: {
  taskStore: TaskStore;
  projectIds?: string[];
  callerAgentId?: string;
  callerWorkspaceId?: string;
  callerProjectId?: string;
}): PaseoToolCatalog {
  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    handler: PaseoToolDefinition["handler"],
  ) => {
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler,
    });
  };

  const projects = new Map(
    (input.projectIds ?? ["project-a"]).map((projectId) => [
      projectId,
      { projectId, archivedAt: null },
    ]),
  );

  registerBacklogTools({
    registerTool,
    taskStore: input.taskStore,
    projectRegistry: {
      get: async (projectId) => projects.get(projectId) ?? null,
      list: async () => [...projects.values()],
    },
    workspaceRegistry: {
      get: async (workspaceId) =>
        workspaceId === (input.callerWorkspaceId ?? "ws-1")
          ? {
              workspaceId,
              projectId: input.callerProjectId ?? "project-a",
            }
          : null,
    },
    callerAgentId: input.callerAgentId,
    resolveCallerAgent: () =>
      input.callerAgentId ? { workspaceId: input.callerWorkspaceId ?? "ws-1" } : null,
  });

  return {
    tools,
    getTool: (name) => tools.get(name),
    executeTool: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`missing tool ${name}`);
      }
      return tool.handler(args, {});
    },
  };
}

describe("backlog MCP tools", () => {
  it("lists filters creates updates resolves and deletes backlog tasks", async () => {
    const home = makeHome();
    const store = new TaskStore(home);
    await store.create({
      projectId: "project-a",
      title: "Ship search",
      description: "Add query box",
      uploads: [],
    });
    await store.create({
      projectId: "project-a",
      title: "Fix login",
      description: "Token refresh",
      uploads: [],
    });

    const catalog = createCatalog({
      taskStore: store,
      callerAgentId: "agent-1",
      callerProjectId: "project-a",
    });

    const listed = await catalog.executeTool("list_backlog_tasks", { query: "search" });
    expect(listed.structuredContent).toMatchObject({
      projectId: "project-a",
      tasks: [{ title: "Ship search" }],
    });

    const created = await catalog.executeTool("create_backlog_task", {
      title: "Write docs",
      description: "Document tools",
    });
    const createdTask = (created.structuredContent as { task: { id: string } }).task;

    const updated = await catalog.executeTool("update_backlog_task", {
      taskId: createdTask.id,
      title: "Write backlog docs",
    });
    expect(updated.structuredContent).toMatchObject({
      task: { title: "Write backlog docs", status: "active" },
    });

    const resolved = await catalog.executeTool("resolve_backlog_task", {
      taskId: createdTask.id,
    });
    expect(resolved.structuredContent).toMatchObject({
      task: { id: createdTask.id, status: "completed" },
    });

    const deleted = await catalog.executeTool("delete_backlog_task", {
      taskId: createdTask.id,
    });
    expect(deleted.structuredContent).toEqual({ taskId: createdTask.id, deleted: true });
    await expect(store.getById(createdTask.id)).resolves.toBeNull();
  });

  it("requires projectId for top-level list unless listing all projects", async () => {
    const home = makeHome();
    const store = new TaskStore(home);
    await store.create({
      projectId: "project-a",
      title: "One",
      description: "",
      uploads: [],
    });
    await store.create({
      projectId: "project-b",
      title: "Two",
      description: "",
      uploads: [],
    });
    const catalog = createCatalog({
      taskStore: store,
      projectIds: ["project-a", "project-b"],
    });

    await expect(catalog.executeTool("list_backlog_tasks", {})).rejects.toThrow(
      /projectId is required/,
    );

    const all = await catalog.executeTool("list_backlog_tasks", { allProjects: true });
    expect((all.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it("links create_agent backlog metadata into prompt and labels", async () => {
    const home = makeHome();
    const store = new TaskStore(home);
    const task = await store.create({
      projectId: "project-a",
      title: "Ship search",
      description: "Add query box",
      uploads: [],
    });

    const linked = await resolveBacklogLinkForAgentCreate({
      taskStore: store,
      projectRegistry: {
        get: async () => ({ projectId: "project-a", archivedAt: null }),
        list: async () => [{ projectId: "project-a", archivedAt: null }],
      },
      resolveCallerAgent: () => null,
      backlogTaskId: task.id,
    });

    expect(linked.labels).toEqual({
      [BACKLOG_TASK_ID_LABEL]: task.id,
      [BACKLOG_PROJECT_ID_LABEL]: "project-a",
    });
    expect(mergeBacklogIntoCreateAgentPrompt({ initialPrompt: "Do the work", task })).toContain(
      `Backlog task ID: ${task.id}`,
    );
    expect(mergeBacklogIntoCreateAgentPrompt({ initialPrompt: "Do the work", task })).toContain(
      "resolve_backlog_task",
    );
  });
});
