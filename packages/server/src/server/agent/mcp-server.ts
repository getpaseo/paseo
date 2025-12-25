import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensureValidJson } from "../json-utils.js";
import type {
  AgentPromptInput,
  AgentProvider,
  AgentPermissionRequest,
} from "./agent-sdk-types.js";
import type {
  AgentManager,
  ManagedAgent,
  WaitForAgentResult,
} from "./agent-manager.js";
import {
  AgentPermissionRequestPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  serializeAgentSnapshot,
} from "../messages.js";
import { toAgentPayload } from "./agent-projections.js";
import { curateAgentActivity } from "./activity-curator.js";
import { AGENT_PROVIDER_DEFINITIONS } from "./provider-manifest.js";
import { AgentRegistry } from "./agent-registry.js";
import { createWorktree } from "../../utils/worktree.js";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";

export interface AgentMcpServerOptions {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  /**
   * ID of the agent that is connecting to this MCP server.
   * When set, create_agent will auto-inject this as parentAgentId.
   */
  callerAgentId?: string;
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

function sanitizePermissionRequest(
  permission: AgentPermissionRequest | null | undefined
): AgentPermissionRequest | null {
  if (!permission) {
    return null;
  }
  const sanitized: AgentPermissionRequest = { ...permission };
  if (sanitized.title === undefined) {
    delete sanitized.title;
  }
  if (sanitized.description === undefined) {
    delete sanitized.description;
  }
  if (sanitized.input === undefined) {
    delete sanitized.input;
  }
  if (sanitized.suggestions === undefined) {
    delete sanitized.suggestions;
  }
  if (sanitized.metadata === undefined) {
    delete sanitized.metadata;
  }
  return sanitized;
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
  snapshot: ManagedAgent
) {
  const title = await resolveAgentTitle(agentRegistry, snapshot.id);
  return serializeAgentSnapshot(snapshot, { title });
}

export async function createAgentMcpServer(
  options: AgentMcpServerOptions
): Promise<McpServer> {
  const { agentManager, agentRegistry, callerAgentId } = options;
  const waitTracker = new WaitForAgentTracker();

  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  server.registerTool(
    "create_agent",
    {
      title: "Create Agent",
      description:
        "Create a new Claude or Codex agent tied to a working directory. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "Required working directory for the agent (absolute, relative, or ~)."
          ),
        title: z
          .string()
          .trim()
          .min(1, "Title is required")
          .max(40, "Title must be 40 characters or fewer")
          .describe(
            "Short descriptive title (<= 40 chars) summarizing the agent's focus. Use a single concise sentence that fits on mobile."
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
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately."
          ),
        parentAgentId: z
          .string()
          .optional()
          .describe(
            "Optional parent agent ID. When set, this agent is a child of the specified parent agent."
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
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async ({
      cwd,
      agentType,
      initialPrompt,
      initialMode,
      worktreeName,
      background = false,
      title,
      parentAgentId,
    }) => {
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
      const normalizedTitle = title?.trim() ?? null;
      // Use explicit parentAgentId if provided, otherwise default to caller agent ID
      const resolvedParentAgentId = parentAgentId ?? callerAgentId;
      const snapshot = await agentManager.createAgent({
        provider,
        cwd: resolvedCwd,
        modeId: initialMode,
        title: normalizedTitle ?? undefined,
        parentAgentId: resolvedParentAgentId,
      });

      if (initialPrompt) {
        try {
          agentManager.recordUserMessage(snapshot.id, initialPrompt);
        } catch (error) {
          console.error(
            `[Agent MCP] Failed to record initial prompt for ${snapshot.id}:`,
            error
          );
        }

        try {
          startAgentRun(agentManager, snapshot.id, initialPrompt);

          // If not running in background, wait for completion
          if (!background) {
            const result = await agentManager.waitForAgentEvent(snapshot.id, {
              waitForActive: true,
            });

            const responseData = {
              agentId: snapshot.id,
              type: provider,
              status: result.status,
              cwd: snapshot.cwd,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
              lastMessage: result.lastMessage,
              permission: sanitizePermissionRequest(result.permission),
            };
            const validJson = ensureValidJson(responseData);

            const response = {
              content: [],
              structuredContent: validJson,
            };
            return response;
          }
        } catch (error) {
          console.error(
            `[Agent MCP] Failed to run initial prompt for ${snapshot.id}:`,
            error
          );
        }
      } else {
      }

      // Return immediately if background=true or no initialPrompt
      const response = {
        content: [],
        structuredContent: ensureValidJson({
          agentId: snapshot.id,
          type: provider,
          status: snapshot.lifecycle,
          cwd: snapshot.cwd,
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
          lastMessage: null,
          permission: null,
        }),
      };
      return response;
    }
  );

  server.registerTool(
    "wait_for_agent",
    {
      title: "Wait For Agent",
      description:
        "Block until the agent requests permission or the current run completes. Returns the pending permission (if any) and recent activity summary.",
      inputSchema: {
        agentId: z
          .string()
          .describe("Agent identifier returned by the create_agent tool"),
      },
      outputSchema: {
        agentId: z.string(),
        status: AgentStatusEnum,
        permission: AgentPermissionRequestPayloadSchema.nullable(),
        lastMessage: z.string().nullable(),
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

        const validJson = ensureValidJson({
          agentId,
          status: result.status,
          permission: sanitizePermissionRequest(result.permission),
          lastMessage: result.lastMessage,
        });

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
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
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately."
          ),
      },
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async ({ agentId, prompt, sessionMode, background = false }) => {
      // Check if agent is running and interrupt if necessary (matches app behavior)
      const snapshot = agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent ${agentId} not found`);
      }

      if (snapshot.lifecycle === "running" || snapshot.pendingRun) {
        console.log(
          `[Agent MCP] Interrupting active run for ${agentId} before sending new prompt`
        );
        try {
          const cancelled = await agentManager.cancelAgentRun(agentId);
          if (!cancelled) {
            console.warn(
              `[Agent MCP] Agent ${agentId} reported running but no active run was cancelled`
            );
          }
          // Also cancel any pending wait_for_agent calls for this agent
          waitTracker.cancel(agentId, "Agent run interrupted by new prompt");

          // Wait for the agent to become idle after cancellation
          // Poll until the agent is no longer running and has no pending run
          // This is necessary because cancelAgentRun only initiates cancellation
          // and doesn't wait for the generator to fully terminate
          const maxWaitMs = 5000;
          const pollIntervalMs = 50;
          const startTime = Date.now();
          while (Date.now() - startTime < maxWaitMs) {
            const current = agentManager.getAgent(agentId);
            if (!current) {
              throw new Error(`Agent ${agentId} not found during cancellation wait`);
            }
            if (current.lifecycle !== "running" && !current.pendingRun) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
        } catch (error) {
          console.error(
            `[Agent MCP] Failed to interrupt agent ${agentId}:`,
            error
          );
          throw error;
        }
      }

      if (sessionMode) {
        await agentManager.setAgentMode(agentId, sessionMode);
      }

      try {
        agentManager.recordUserMessage(agentId, prompt);
      } catch (error) {
        console.error(
          `[Agent MCP] Failed to record user message for ${agentId}:`,
          error
        );
      }

      startAgentRun(agentManager, agentId, prompt);

      // If not running in background, wait for completion
      if (!background) {
        const result = await agentManager.waitForAgentEvent(agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }


      // Return immediately if background=true
      // Re-fetch snapshot since the state may have changed
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
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
          status: snapshot.lifecycle,
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
      if (success) {
        waitTracker.cancel(agentId, "Agent run cancelled");
      }
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
      waitTracker.cancel(agentId, "Agent terminated");
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
        "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      const activitiesToCurate = limit
        ? timeline.slice(-limit)
        : timeline;

      const curatedContent = curateAgentActivity(activitiesToCurate);
      const totalCount = timeline.length;
      const shownCount = activitiesToCurate.length;

      let countHeader: string;
      if (limit && shownCount < totalCount) {
        countHeader = `Showing ${shownCount} of ${totalCount} ${totalCount === 1 ? 'activity' : 'activities'} (limited to ${limit})`;
      } else {
        countHeader = `Showing all ${totalCount} ${totalCount === 1 ? 'activity' : 'activities'}`;
      }

      const contentWithCount = `${countHeader}\n\n${curatedContent}`;

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: contentWithCount,
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
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request,
        }));
      });

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
