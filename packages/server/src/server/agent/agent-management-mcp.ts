/**
 * Agent Management MCP Server
 *
 * Purpose: Managing agents from the UI/voice assistant LLM
 * Transport: In-memory (runs in-process with the voice assistant LLM)
 * Server name: "paseo-agent-management"
 *
 * Tools:
 * - create_agent
 * - wait_for_agent
 * - send_agent_prompt
 * - get_agent_status
 * - list_agents
 * - cancel_agent
 * - kill_agent
 * - get_agent_activity
 * - set_agent_mode
 * - list_pending_permissions
 * - respond_to_permission
 *
 * No callerAgentId needed - voice assistant is not an agent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensureValidJson } from "../json-utils.js";
import type { Logger } from "pino";

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
import { AGENT_PROVIDER_DEFINITIONS } from "./provider-registry.js";
import { AgentStorage } from "./agent-storage.js";
import { createWorktree } from "../../utils/worktree.js";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";
import { injectLeadingPaseoInstructionTag } from "./paseo-instructions-tag.js";

export interface AgentManagementMcpOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  paseoHome?: string;
  logger: Logger;
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

// 50 seconds - surface friendly message before SDK tool timeout (~60s)
const AGENT_WAIT_TIMEOUT_MS = 50000;

function expandPath(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

async function waitForAgentWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  options?: {
    signal?: AbortSignal;
    waitForActive?: boolean;
  }
): Promise<WaitForAgentResult> {
  const timeoutController = new AbortController();
  const combinedController = new AbortController();

  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error("wait timeout"));
  }, AGENT_WAIT_TIMEOUT_MS);

  const forwardAbort = (reason: unknown) => {
    if (!combinedController.signal.aborted) {
      combinedController.abort(reason);
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      forwardAbort(options.signal.reason);
    } else {
      options.signal.addEventListener(
        "abort",
        () => forwardAbort(options.signal!.reason),
        { once: true }
      );
    }
  }

  timeoutController.signal.addEventListener(
    "abort",
    () => forwardAbort(timeoutController.signal.reason),
    { once: true }
  );

  try {
    const result = await agentManager.waitForAgentEvent(agentId, {
      signal: combinedController.signal,
      waitForActive: options?.waitForActive,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "wait timeout") {
      const snapshot = agentManager.getAgent(agentId);
      const timeline = agentManager.getTimeline(agentId);
      const recentActivity = curateAgentActivity(timeline.slice(-5));
      const message = `Awaiting the agent timed out. This does not mean the agent failed - call wait_for_agent again to continue waiting.\n\nRecent activity:\n${recentActivity}`;
      return {
        status: snapshot?.lifecycle ?? "idle",
        permission: null,
        lastMessage: message,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function startAgentRun(
  agentManager: AgentManager,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger
): void {
  const iterator = agentManager.streamAgent(agentId, prompt);
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
    } catch (error) {
      logger.error({ err: error, agentId }, "Agent stream failed");
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
  agentStorage: AgentStorage,
  agentId: string,
  logger: Logger
): Promise<string | null> {
  try {
    const record = await agentStorage.get(agentId);
    return record?.title ?? null;
  } catch (error) {
    logger.error({ err: error, agentId }, "Failed to load agent title");
    return null;
  }
}

async function serializeSnapshotWithMetadata(
  agentStorage: AgentStorage,
  snapshot: ManagedAgent,
  logger: Logger
) {
  const title = await resolveAgentTitle(agentStorage, snapshot.id, logger);
  return serializeAgentSnapshot(snapshot, { title });
}

export async function createAgentManagementMcpServer(
  options: AgentManagementMcpOptions
): Promise<McpServer> {
  const { agentManager, agentStorage, logger } = options;
  const childLogger = logger.child({
    module: "agent",
    component: "agent-management-mcp",
  });
  const waitTracker = new WaitForAgentTracker(logger);

  const server = new McpServer({
    name: "paseo-agent-management",
    version: "1.0.0",
  });

  const inputSchema = {
    cwd: z
      .string()
      .describe(
        "Required working directory for the agent (absolute, relative, or ~)."
      ),
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe(
        "Short descriptive title (<= 60 chars) summarizing the agent's focus."
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
      .describe("Required session mode to configure before the first run."),
    worktreeName: z
      .string()
      .optional()
      .describe(
        "Optional git worktree branch name (lowercase alphanumerics + hyphen)."
      ),
    baseBranch: z
      .string()
      .optional()
      .describe(
        "Required when worktreeName is set: the base branch to diff/merge against."
      ),
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately."
      ),
  };

  server.registerTool(
    "create_agent",
    {
      title: "Create Agent",
      description:
        "Create a new Claude or Codex agent tied to a working directory. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema,
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
    async (args) => {
      const {
        cwd,
        agentType,
        initialPrompt,
        initialMode,
        worktreeName,
        baseBranch,
        background = false,
        title,
      } = args as {
        cwd: string;
        agentType?: AgentProvider;
        initialPrompt?: string;
        initialMode: string;
        worktreeName?: string;
        baseBranch?: string;
        background?: boolean;
        title: string;
      };

      let resolvedCwd = expandPath(cwd);

      if (worktreeName) {
        if (!baseBranch) {
          throw new Error("baseBranch is required when creating a worktree");
        }
        const worktree = await createWorktree({
          branchName: worktreeName,
          cwd: resolvedCwd,
          baseBranch,
          worktreeSlug: worktreeName,
          paseoHome: options.paseoHome,
        });
        resolvedCwd = worktree.worktreePath;
      }

      const provider: AgentProvider = agentType ?? "claude";
      const normalizedTitle = title?.trim() ?? null;
      const snapshot = await agentManager.createAgent({
        provider,
        cwd: resolvedCwd,
        modeId: initialMode,
        title: normalizedTitle ?? undefined,
      });

      if (initialPrompt) {
        const initialPromptWithInstructions = injectLeadingPaseoInstructionTag(
          initialPrompt,
          snapshot.config.paseoPromptInstructions
        );
        try {
          agentManager.recordUserMessage(
            snapshot.id,
            initialPromptWithInstructions
          );
        } catch (error) {
          childLogger.error(
            { err: error, agentId: snapshot.id },
            "Failed to record initial prompt"
          );
        }

        try {
          startAgentRun(
            agentManager,
            snapshot.id,
            initialPromptWithInstructions,
            childLogger
          );

          if (!background) {
            const result = await waitForAgentWithTimeout(
              agentManager,
              snapshot.id,
              { waitForActive: true }
            );

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

            return {
              content: [],
              structuredContent: validJson,
            };
          }
        } catch (error) {
          childLogger.error(
            { err: error, agentId: snapshot.id },
            "Failed to run initial prompt"
          );
        }
      }

      return {
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
          signal.addEventListener("abort", forwardExternalAbort, {
            once: true,
          });
          cleanupFns.push(() =>
            signal.removeEventListener("abort", forwardExternalAbort)
          );
        }
      }

      const unregister = waitTracker.register(agentId, (reason) => {
        if (!abortController.signal.aborted) {
          abortController.abort(
            new Error(reason ?? "wait_for_agent cancelled")
          );
        }
      });
      cleanupFns.push(unregister);

      try {
        const result: WaitForAgentResult = await waitForAgentWithTimeout(
          agentManager,
          agentId,
          { signal: abortController.signal }
        );

        const validJson = ensureValidJson({
          agentId,
          status: result.status,
          permission: sanitizePermissionRequest(result.permission),
          lastMessage: result.lastMessage,
        });

        return {
          content: [],
          structuredContent: validJson,
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
      const snapshot = agentManager.getAgent(agentId);
      if (!snapshot) {
        throw new Error(`Agent ${agentId} not found`);
      }

      if (snapshot.lifecycle === "running" || snapshot.pendingRun) {
        childLogger.debug(
          { agentId },
          "Interrupting active run before sending new prompt"
        );
        try {
          const cancelled = await agentManager.cancelAgentRun(agentId);
          if (!cancelled) {
            childLogger.warn(
              { agentId },
              "Agent reported running but no active run was cancelled"
            );
          }
          waitTracker.cancel(agentId, "Agent run interrupted by new prompt");

          const maxWaitMs = 5000;
          const pollIntervalMs = 50;
          const startTime = Date.now();
          while (Date.now() - startTime < maxWaitMs) {
            const current = agentManager.getAgent(agentId);
            if (!current) {
              throw new Error(
                `Agent ${agentId} not found during cancellation wait`
              );
            }
            if (current.lifecycle !== "running" && !current.pendingRun) {
              break;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, pollIntervalMs)
            );
          }
        } catch (error) {
          childLogger.error(
            { err: error, agentId },
            "Failed to interrupt agent"
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
        childLogger.error(
          { err: error, agentId },
          "Failed to record user message"
        );
      }

      startAgentRun(agentManager, agentId, prompt, childLogger);

      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        return {
          content: [],
          structuredContent: validJson,
        };
      }

      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
      };
      const validJson = ensureValidJson(responseData);

      return {
        content: [],
        structuredContent: validJson,
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
        agentStorage,
        snapshot,
        childLogger
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
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger)
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
          .describe(
            "Optional limit for number of activities to include (most recent first)."
          ),
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

      const activitiesToCurate = limit ? timeline.slice(-limit) : timeline;

      const curatedContent = curateAgentActivity(activitiesToCurate);
      const totalCount = timeline.length;
      const shownCount = activitiesToCurate.length;

      let countHeader: string;
      if (limit && shownCount < totalCount) {
        countHeader = `Showing ${shownCount} of ${totalCount} ${totalCount === 1 ? "activity" : "activities"} (limited to ${limit})`;
      } else {
        countHeader = `Showing all ${totalCount} ${totalCount === 1 ? "activity" : "activities"}`;
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
