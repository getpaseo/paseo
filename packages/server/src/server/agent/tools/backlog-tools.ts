import { z } from "zod";
import {
  appendBacklogTaskResolutionFooter,
  buildBacklogTaskLabels,
} from "@getpaseo/protocol/tasks/prompt";
import { TaskCardSchema, type TaskCard, type TaskStatus } from "@getpaseo/protocol/tasks/types";
import { ensureValidJson } from "../../json-utils.js";
import type { TaskStore } from "../../tasks/task-store.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
  handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
) => void;

export interface BacklogToolsOptions {
  registerTool: RegisterTool;
  taskStore: TaskStore;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
  callerAgentId?: string;
  resolveCallerAgent: () => { workspaceId?: string } | null;
}

const TaskStatusInputSchema = z.enum(["active", "completed"]);

function matchesQuery(task: TaskCard, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return true;
  }
  return `${task.title}\n${task.description}`.toLowerCase().includes(normalized);
}

function matchesStatus(task: TaskCard, status: TaskStatus | undefined): boolean {
  return status === undefined || task.status === status;
}

export function registerBacklogTools(options: BacklogToolsOptions): void {
  const { registerTool, taskStore, projectRegistry, workspaceRegistry, callerAgentId } = options;

  const requireTaskStore = (): TaskStore => taskStore;

  const requireProject = async (projectId: string): Promise<void> => {
    if (!projectRegistry) {
      throw new Error("Project registry is not configured");
    }
    const project = await projectRegistry.get(projectId);
    if (!project || project.archivedAt) {
      throw new Error(`Project not found: ${projectId}`);
    }
  };

  const resolveProjectId = async (requested?: string): Promise<string> => {
    const explicit = requested?.trim();
    if (explicit) {
      await requireProject(explicit);
      return explicit;
    }
    if (!callerAgentId) {
      throw new Error("projectId is required outside an agent-scoped session");
    }
    const caller = options.resolveCallerAgent();
    if (!caller?.workspaceId) {
      throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
    }
    if (!workspaceRegistry) {
      throw new Error("Workspace registry is not configured");
    }
    const workspace = await workspaceRegistry.get(caller.workspaceId);
    if (!workspace?.projectId) {
      throw new Error(`Workspace ${caller.workspaceId} has no project`);
    }
    await requireProject(workspace.projectId);
    return workspace.projectId;
  };

  const resolveTask = async (input: { taskId: string; projectId?: string }): Promise<TaskCard> => {
    const taskId = input.taskId.trim();
    if (!taskId) {
      throw new Error("taskId is required");
    }
    const store = requireTaskStore();
    if (input.projectId?.trim()) {
      const projectId = await resolveProjectId(input.projectId);
      const task = await store.get({ projectId, taskId });
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return task;
    }
    const task = await store.getById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    await requireProject(task.projectId);
    return task;
  };

  registerTool(
    "list_backlog_tasks",
    {
      title: "List backlog tasks",
      description:
        "List project backlog tasks. Agent-scoped calls default to the caller's project. Optionally filter by status and free-text query over title/description.",
      inputSchema: {
        projectId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Project id. Defaults to the caller agent's project in agent-scoped sessions. Required top-level unless listing all active projects.",
          ),
        status: TaskStatusInputSchema.optional().describe(
          "Optional status filter: active or completed.",
        ),
        query: z
          .string()
          .optional()
          .describe("Optional case-insensitive search over title and description."),
        allProjects: z
          .boolean()
          .optional()
          .describe(
            "When true and projectId is omitted, list tasks across all active projects. Top-level only by default when projectId is omitted.",
          ),
      },
      outputSchema: {
        tasks: z.array(TaskCardSchema),
        projectId: z.string().nullable(),
      },
    },
    async ({ projectId, status, query, allProjects }) => {
      const store = requireTaskStore();
      let tasks: TaskCard[];
      let resolvedProjectId: string | null = null;

      if (projectId?.trim()) {
        resolvedProjectId = await resolveProjectId(projectId);
        tasks = await store.list(resolvedProjectId);
      } else if (allProjects === true) {
        if (!projectRegistry) {
          throw new Error("Project registry is not configured");
        }
        const activeProjectIds = new Set(
          (await projectRegistry.list())
            .filter((project) => !project.archivedAt)
            .map((project) => project.projectId),
        );
        tasks = await store.listAll(activeProjectIds);
      } else if (callerAgentId) {
        resolvedProjectId = await resolveProjectId(undefined);
        tasks = await store.list(resolvedProjectId);
      } else {
        throw new Error(
          "projectId is required outside an agent-scoped session (or set allProjects)",
        );
      }

      const filtered = tasks.filter(
        (task) => matchesStatus(task, status) && matchesQuery(task, query),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          tasks: filtered,
          projectId: resolvedProjectId,
        }),
      };
    },
  );

  registerTool(
    "get_backlog_task",
    {
      title: "Get backlog task",
      description:
        "Fetch one backlog task by id. projectId is optional when the task id is unique.",
      inputSchema: {
        taskId: z.string().min(1),
        projectId: z.string().min(1).optional(),
      },
      outputSchema: {
        task: TaskCardSchema,
      },
    },
    async ({ taskId, projectId }) => {
      const task = await resolveTask({ taskId, projectId });
      return {
        content: [],
        structuredContent: ensureValidJson({ task }),
      };
    },
  );

  registerTool(
    "create_backlog_task",
    {
      title: "Create backlog task",
      description:
        "Create a new active backlog task for a project. Attachments are not supported over this tool.",
      inputSchema: {
        title: z.string().trim().min(1, "title is required"),
        description: z.string().optional().default(""),
        projectId: z
          .string()
          .min(1)
          .optional()
          .describe("Project id. Defaults to the caller agent's project when omitted."),
      },
      outputSchema: {
        task: TaskCardSchema,
      },
    },
    async ({ title, description, projectId }) => {
      const resolvedProjectId = await resolveProjectId(projectId);
      const task = await requireTaskStore().create({
        projectId: resolvedProjectId,
        title,
        description: description ?? "",
        uploads: [],
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ task }),
      };
    },
  );

  registerTool(
    "update_backlog_task",
    {
      title: "Update backlog task",
      description: "Update a backlog task title, description, and/or status.",
      inputSchema: {
        taskId: z.string().min(1),
        projectId: z.string().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        status: TaskStatusInputSchema.optional(),
      },
      outputSchema: {
        task: TaskCardSchema,
      },
    },
    async ({ taskId, projectId, title, description, status }) => {
      if (title === undefined && description === undefined && status === undefined) {
        throw new Error("Provide title, description, and/or status to update");
      }
      const current = await resolveTask({ taskId, projectId });
      const task = await requireTaskStore().update({
        projectId: current.projectId,
        taskId: current.id,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ task }),
      };
    },
  );

  registerTool(
    "resolve_backlog_task",
    {
      title: "Resolve backlog task",
      description: "Mark a backlog task completed when the work is done.",
      inputSchema: {
        taskId: z.string().min(1),
        projectId: z.string().min(1).optional(),
      },
      outputSchema: {
        task: TaskCardSchema,
      },
    },
    async ({ taskId, projectId }) => {
      const current = await resolveTask({ taskId, projectId });
      const task = await requireTaskStore().update({
        projectId: current.projectId,
        taskId: current.id,
        status: "completed",
      });
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ task }),
      };
    },
  );

  registerTool(
    "delete_backlog_task",
    {
      title: "Delete backlog task",
      description: "Permanently delete a backlog task and its attachments.",
      inputSchema: {
        taskId: z.string().min(1),
        projectId: z.string().min(1).optional(),
      },
      outputSchema: {
        taskId: z.string(),
        deleted: z.boolean(),
      },
    },
    async ({ taskId, projectId }) => {
      const current = await resolveTask({ taskId, projectId });
      const deleted = await requireTaskStore().delete({
        projectId: current.projectId,
        taskId: current.id,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ taskId: current.id, deleted }),
      };
    },
  );
}

export async function resolveBacklogLinkForAgentCreate(input: {
  taskStore: TaskStore;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get">;
  callerAgentId?: string;
  resolveCallerAgent: () => { workspaceId?: string } | null;
  backlogTaskId: string;
  backlogProjectId?: string;
}): Promise<{ task: TaskCard; labels: Record<string, string>; promptFooter: string }> {
  const taskId = input.backlogTaskId.trim();
  if (!taskId) {
    throw new Error("backlogTaskId is required");
  }

  let task: TaskCard | null = null;
  if (input.backlogProjectId?.trim()) {
    const projectId = input.backlogProjectId.trim();
    if (!input.projectRegistry) {
      throw new Error("Project registry is not configured");
    }
    const project = await input.projectRegistry.get(projectId);
    if (!project || project.archivedAt) {
      throw new Error(`Project not found: ${projectId}`);
    }
    task = await input.taskStore.get({ projectId, taskId });
  } else {
    task = await input.taskStore.getById(taskId);
    if (task) {
      if (!input.projectRegistry) {
        throw new Error("Project registry is not configured");
      }
      const project = await input.projectRegistry.get(task.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${task.projectId}`);
      }
    }
  }

  if (!task) {
    throw new Error(`Backlog task not found: ${taskId}`);
  }

  return {
    task,
    labels: buildBacklogTaskLabels(task),
    promptFooter: appendBacklogTaskResolutionFooter("", task).trim(),
  };
}

export function mergeBacklogIntoCreateAgentPrompt(input: {
  initialPrompt: string;
  task: TaskCard;
}): string {
  return appendBacklogTaskResolutionFooter(input.initialPrompt, input.task);
}
