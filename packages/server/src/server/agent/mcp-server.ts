import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AgentPromptInput,
  AgentProvider,
  AgentPermissionRequest,
} from "./agent-sdk-types.js";
import type {
  AgentLifecycleStatus,
  AgentManager,
  AgentSnapshot,
} from "./agent-manager.js";
import {
  AgentPermissionRequestPayloadSchema,
  AgentPermissionResponseSchema,
  AgentTimelineItemPayloadSchema,
  AgentSnapshotPayloadSchema,
  serializeAgentSnapshot,
} from "../messages.js";
import { curateAgentActivity } from "./activity-curator.js";
import { AGENT_PROVIDER_DEFINITIONS } from "./provider-manifest.js";
import { AgentRegistry } from "./agent-registry.js";
import { createWorktree } from "../../utils/worktree.js";

export interface AgentMcpServerOptions {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
}

const AgentProviderEnum = z.enum(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => definition.id) as [
    AgentProvider,
    ...AgentProvider[],
  ]
);

const AgentStatusEnum = z.enum([
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
]);

function expandPath(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function startAgentRun(
  agentManager: AgentManager,
  agentId: string,
  prompt: AgentPromptInput
): void {
  const iterator = agentManager.streamAgent(agentId, prompt);
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
    } catch (error) {
      console.error(
        `[Agent MCP] Agent stream failed for ${agentId}:`,
        error
      );
    }
  })();
}

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return status === "running" || status === "initializing";
}

async function resolveAgentTitle(
  agentRegistry: AgentRegistry,
  agentId: string
): Promise<string | null> {
  try {
    const record = await agentRegistry.get(agentId);
    return record?.title ?? null;
  } catch (error) {
    console.error(
      `[Agent MCP] Failed to load agent title for ${agentId}:`,
      error
    );
    return null;
  }
}

async function serializeSnapshotWithMetadata(
  agentRegistry: AgentRegistry,
  snapshot: AgentSnapshot
) {
  const title = await resolveAgentTitle(agentRegistry, snapshot.id);
  return serializeAgentSnapshot(snapshot, { title });
}

async function waitForAgentEvent(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal
): Promise<{
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
}> {
  const snapshot = agentManager.getAgent(agentId);
  if (!snapshot) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const existingPermission = snapshot.pendingPermissions[0] ?? null;
  if (existingPermission) {
    return { status: snapshot.status, permission: existingPermission };
  }

  if (!isAgentBusy(snapshot.status)) {
    return { status: snapshot.status, permission: null };
  }

  return await new Promise((resolve, reject) => {
    let currentStatus: AgentLifecycleStatus = snapshot.status;
    const cleanupFns: Array<() => void> = [];

    const cleanup = () => {
      while (cleanupFns.length) {
        const fn = cleanupFns.pop();
        try {
          fn?.();
        } catch {
          // ignore cleanup errors
        }
      }
    };

    const finish = (permission: AgentPermissionRequest | null) => {
      cleanup();
      resolve({ status: currentStatus, permission });
    };

    const unsubscribe = agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          currentStatus = event.agent.status;
          if (!isAgentBusy(event.agent.status)) {
            const pending = event.agent.pendingPermissions[0] ?? null;
            finish(pending);
          }
          return;
        }

        if (
          event.type === "agent_stream" &&
          event.event.type === "permission_requested"
        ) {
          currentStatus = "running";
          finish(event.event.request);
        }
      },
      { agentId, replayState: false }
    );
    cleanupFns.push(unsubscribe);

    if (signal) {
      const abort = () => {
        cleanup();
        reject(
          Object.assign(new Error("wait_for_agent aborted"), {
            name: "AbortError",
          })
        );
      };

      if (signal.aborted) {
        abort();
        return;
      }

      signal.addEventListener("abort", abort, { once: true });
      cleanupFns.push(() => signal.removeEventListener("abort", abort));
    }
  });
}

function buildActivityPayload(
  agentManager: AgentManager,
  agentId: string
): {
  format: "curated";
  updateCount: number;
  currentModeId: string | null;
  content: string;
} {
  const timeline = agentManager.getTimeline(agentId);
  const snapshot = agentManager.getAgent(agentId);
  const curatedText = curateAgentActivity(timeline);

  return {
    format: "curated",
    updateCount: timeline.length,
    currentModeId: snapshot?.currentModeId ?? null,
    content: curatedText,
  };
}

export async function createAgentMcpServer(
  options: AgentMcpServerOptions
): Promise<McpServer> {
  const { agentManager, agentRegistry } = options;

  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  server.registerTool(
    "create_coding_agent",
    {
      title: "Create Coding Agent",
      description:
        "Create a new Claude or Codex agent tied to a working directory. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "Required working directory for the agent (absolute, relative, or ~)."
          ),
        agentType: AgentProviderEnum.optional().describe(
          "Optional agent implementation to spawn. Defaults to 'claude'."
        ),
        initialPrompt: z
          .string()
          .optional()
          .describe(
            "Optional task to start immediately after creation (non-blocking)."
          ),
        initialMode: z
          .string()
          .optional()
          .describe("Optional session mode to configure before the first run."),
        worktreeName: z
          .string()
          .optional()
          .describe(
            "Optional git worktree branch name (lowercase alphanumerics + hyphen)."
          ),
      },
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string().nullable().optional(),
          })
        ),
      },
    },
    async ({ cwd, agentType, initialPrompt, initialMode, worktreeName }) => {
      let resolvedCwd = expandPath(cwd);

      if (worktreeName) {
        const worktree = await createWorktree({
          branchName: worktreeName,
          cwd: resolvedCwd,
        });
        resolvedCwd = worktree.worktreePath;
      }

      const provider: AgentProvider = agentType ?? "claude";
      const snapshot = await agentManager.createAgent({
        provider,
        cwd: resolvedCwd,
        modeId: initialMode,
      });

      if (initialPrompt) {
        try {
          startAgentRun(agentManager, snapshot.id, initialPrompt);
        } catch (error) {
          console.error(
            `[Agent MCP] Failed to run initial prompt for ${snapshot.id}:`,
            error
          );
        }
      }

      return {
        content: [],
        structuredContent: {
          agentId: snapshot.id,
          type: provider,
          status: snapshot.status,
          cwd: snapshot.cwd,
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
        },
      };
    }
  );

  server.registerTool(
    "wait_for_agent",
    {
      title: "Wait For Agent",
      description:
        "Block until the agent requests permission or the current run completes. Returns the pending permission (if any) and recent activity summary.",
      inputSchema: {
        agentId: z.string().describe("Agent identifier from create_coding_agent"),
      },
      outputSchema: {
        agentId: z.string(),
        status: AgentStatusEnum,
        permission: AgentPermissionRequestPayloadSchema.nullable(),
        activity: z.object({
          format: z.literal("curated"),
          updateCount: z.number(),
          currentModeId: z.string().nullable(),
          content: z.string(),
        }),
      },
    },
    async ({ agentId }, { signal }) => {
      const result = await waitForAgentEvent(agentManager, agentId, signal);
      const activity = buildActivityPayload(agentManager, agentId);

      return {
        content: [],
        structuredContent: {
          agentId,
          status: result.status,
          permission: result.permission,
          activity,
        },
      };
    }
  );

  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send Agent Prompt",
      description:
        "Send a task to a running agent. Returns immediately after the agent begins processing.",
      inputSchema: {
        agentId: z.string(),
        prompt: z.string(),
        sessionMode: z
          .string()
          .optional()
          .describe("Optional mode to set before running the prompt."),
      },
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
      },
    },
    async ({ agentId, prompt, sessionMode }) => {
      if (sessionMode) {
        await agentManager.setAgentMode(agentId, sessionMode);
      }

      startAgentRun(agentManager, agentId, prompt);
      const snapshot = agentManager.getAgent(agentId);

      return {
        content: [],
        structuredContent: {
          success: true,
          status: snapshot?.status ?? "idle",
        },
      };
    }
  );

  server.registerTool(
    "get_agent_status",
    {
      title: "Get Agent Status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent ${agentId} not found`);
      }

      return {
        content: [],
        structuredContent: {
          status: snapshot.status,
          snapshot: await serializeSnapshotWithMetadata(
            agentRegistry,
            snapshot
          ),
        },
      };
    }
  );

  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description: "List all live agents managed by the server.",
      inputSchema: {},
      outputSchema: {
        agents: z.array(AgentSnapshotPayloadSchema),
      },
    },
    async () => {
      const snapshots = agentManager.listAgents();
      const agents = await Promise.all(
        snapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentRegistry, snapshot)
        )
      );
      return {
        content: [],
        structuredContent: { agents },
      };
    }
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel Agent Run",
      description:
        "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const success = await agentManager.cancelAgentRun(agentId);
      return {
        content: [],
        structuredContent: { success },
      };
    }
  );

  server.registerTool(
    "kill_agent",
    {
      title: "Kill Agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await agentManager.closeAgent(agentId);
      return {
        content: [],
        structuredContent: { success: true },
      };
    }
  );

  server.registerTool(
    "get_agent_activity",
    {
      title: "Get Agent Activity",
      description:
        "Return recent agent timeline entries. Default response is a curated summary; raw timeline entries are available via format='raw'.",
      inputSchema: {
        agentId: z.string(),
        format: z.enum(["curated", "raw"]).optional().default("curated"),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for raw entries (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        format: z.enum(["curated", "raw"]),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
        updates: z
          .array(AgentTimelineItemPayloadSchema)
          .nullable()
          .describe("Timeline entries when format='raw'."),
      },
    },
    async ({ agentId, format = "curated", limit }) => {
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      if (format === "curated") {
        return {
          content: [],
          structuredContent: {
            agentId,
            format: "curated" as const,
            updateCount: timeline.length,
            currentModeId: snapshot?.currentModeId ?? null,
            content: curateAgentActivity(timeline),
            updates: null,
          },
        };
      }

      const entries = limit
        ? timeline.slice(-limit).reverse()
        : timeline;
      return {
        content: [],
        structuredContent: {
          agentId,
          format: "raw" as const,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: "",
          updates: entries,
        },
      };
    }
  );

  server.registerTool(
    "set_agent_mode",
    {
      title: "Set Agent Session Mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      await agentManager.setAgentMode(agentId, modeId);
      return {
        content: [],
        structuredContent: { success: true, newMode: modeId },
      };
    }
  );

  server.registerTool(
    "list_pending_permissions",
    {
      title: "List Pending Permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          })
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) =>
        agent.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: agent.status,
          request,
        }))
      );

      return {
        content: [],
        structuredContent: { permissions },
      };
    }
  );

  server.registerTool(
    "respond_to_permission",
    {
      title: "Respond To Permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await agentManager.respondToPermission(agentId, requestId, response);
      return {
        content: [],
        structuredContent: { success: true },
      };
    }
  );

  return server;
}
