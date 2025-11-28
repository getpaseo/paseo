import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensureValidJson } from "../json-utils.js";
import type {
  AgentPromptInput,
  AgentProvider,
} from "./agent-sdk-types.js";
import type {
  AgentManager,
  AgentSnapshot,
  WaitForAgentResult,
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
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";

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
  const waitTracker = new WaitForAgentTracker();

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
          worktreeSlug: worktreeName,
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
        structuredContent: ensureValidJson({
          agentId: snapshot.id,
          type: provider,
          status: snapshot.status,
          cwd: snapshot.cwd,
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
        }),
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
      const abortController = new AbortController();
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

      const forwardExternalAbort = () => {
        if (!abortController.signal.aborted) {
          const reason = signal?.reason ?? new Error("wait_for_agent aborted");
          abortController.abort(reason);
        }
      };

      if (signal) {
        if (signal.aborted) {
          forwardExternalAbort();
        } else {
          signal.addEventListener("abort", forwardExternalAbort, { once: true });
          cleanupFns.push(() =>
            signal.removeEventListener("abort", forwardExternalAbort)
          );
        }
      }

      const unregister = waitTracker.register(agentId, (reason) => {
        if (!abortController.signal.aborted) {
          abortController.abort(new Error(reason ?? "wait_for_agent cancelled"));
        }
      });
      cleanupFns.push(unregister);

      try {
        const result: WaitForAgentResult =
          await agentManager.waitForAgentEvent(agentId, {
            signal: abortController.signal,
          });
        const activity = buildActivityPayload(agentManager, agentId);

        return {
          content: [],
          structuredContent: ensureValidJson({
            agentId,
            status: result.status,
            permission: result.permission,
            activity,
          }),
        };
      } finally {
        cleanup();
      }
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
        structuredContent: ensureValidJson({
          success: true,
          status: snapshot?.status ?? "idle",
        }),
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

      const structuredSnapshot = await serializeSnapshotWithMetadata(
        agentRegistry,
        snapshot
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: snapshot.status,
          snapshot: structuredSnapshot,
        }),
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
        structuredContent: ensureValidJson({ agents }),
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
        structuredContent: ensureValidJson({ success }),
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
        structuredContent: ensureValidJson({ success: true }),
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
          structuredContent: ensureValidJson({
            agentId,
            format: "curated" as const,
            updateCount: timeline.length,
            currentModeId: snapshot?.currentModeId ?? null,
            content: curateAgentActivity(timeline),
            updates: null,
          }),
        };
      }

      const entries = limit
        ? timeline.slice(-limit).reverse()
        : timeline;
      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          format: "raw" as const,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: "",
          updates: entries,
        }),
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
        structuredContent: ensureValidJson({ success: true, newMode: modeId }),
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
        structuredContent: ensureValidJson({ permissions }),
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
        structuredContent: ensureValidJson({ success: true }),
      };
    }
  );

  return server;
}
