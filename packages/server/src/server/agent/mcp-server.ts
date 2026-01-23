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
import { AgentRegistry } from "./agent-registry.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  validateBranchSlug,
} from "../../utils/worktree.js";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";
import { NotGitRepoError, renameCurrentBranch } from "../../utils/checkout-git.js";
import { injectLeadingPaseoInstructionTag } from "./paseo-instructions-tag.js";

export interface AgentMcpServerOptions {
  agentManager: AgentManager;
  agentRegistry: AgentRegistry;
  /**
   * ID of the agent that is connecting to this MCP server.
   * When set, create_agent will auto-inject this as parentAgentId.
   */
  callerAgentId?: string;
  logger: Logger;
}

const CLAUDE_TO_CODEX_MODE: Record<string, string> = {
  plan: "read-only",
  default: "auto",
  acceptEdits: "auto",
  bypassPermissions: "full-access",
};

const CODEX_TO_CLAUDE_MODE: Record<string, string> = {
  "read-only": "plan",
  auto: "default",
  "full-access": "bypassPermissions",
};

function mapModeAcrossProviders(
  sourceMode: string,
  sourceProvider: AgentProvider,
  targetProvider: AgentProvider
): string {
  if (sourceProvider === targetProvider) {
    return sourceMode;
  }

  if (sourceProvider === "claude" && targetProvider === "codex") {
    const mapped = CLAUDE_TO_CODEX_MODE[sourceMode];
    if (mapped) {
      return mapped;
    }
    return "auto";
  }

  if (sourceProvider === "codex" && targetProvider === "claude") {
    const mapped = CODEX_TO_CLAUDE_MODE[sourceMode];
    if (mapped) {
      return mapped;
    }
    return "default";
  }

  return sourceMode;
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

type ToolErrorCode = "NOT_ALLOWED" | "NOT_GIT_REPO" | "INVALID_BRANCH";

class AgentMcpToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "AgentMcpToolError";
    this.code = code;
  }
}

/**
 * Wraps agentManager.waitForAgentEvent with a self-imposed timeout.
 * Returns a friendly message when timeout occurs, rather than letting
 * the SDK tool timeout trigger a generic "tool failed" error.
 */
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

  // Forward external signal abort
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

  // Forward timeout abort
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
      logger.error(
        { err: error, agentId },
        "Agent stream failed"
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
  agentId: string,
  logger: Logger
): Promise<string | null> {
  try {
    const record = await agentRegistry.get(agentId);
    return record?.title ?? null;
  } catch (error) {
    logger.error(
      { err: error, agentId },
      "Failed to load agent title"
    );
    return null;
  }
}

async function serializeSnapshotWithMetadata(
  agentRegistry: AgentRegistry,
  snapshot: ManagedAgent,
  logger: Logger
) {
  const title = await resolveAgentTitle(agentRegistry, snapshot.id, logger);
  return serializeAgentSnapshot(snapshot, { title });
}

export async function createAgentMcpServer(
  options: AgentMcpServerOptions
): Promise<McpServer> {
  const { agentManager, agentRegistry, callerAgentId, logger } = options;
  const childLogger = logger.child({ module: "agent", component: "mcp-server" });
  const waitTracker = new WaitForAgentTracker(logger);

  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  const agentToAgentInputSchema = {
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
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately."
      ),
  };

  const topLevelInputSchema = {
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
    parentAgentId: z
      .string()
      .optional()
      .describe(
        "Optional parent agent ID. When set, this agent is a child of the specified parent agent."
      ),
  };

  const createAgentInputSchema = callerAgentId
    ? agentToAgentInputSchema
    : topLevelInputSchema;

  server.registerTool(
    "create_agent",
    {
      title: "Create Agent",
      description:
        "Create a new Claude or Codex agent tied to a working directory. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema: createAgentInputSchema,
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
        agentType,
        initialPrompt,
        background = false,
        title,
      } = args as {
        cwd?: string;
        agentType?: AgentProvider;
        initialPrompt?: string;
        initialMode?: string;
        worktreeName?: string;
        background?: boolean;
        title: string;
        parentAgentId?: string;
      };

      let resolvedCwd: string;
      let resolvedMode: string | undefined;
      let resolvedParentAgentId: string | undefined;

      if (callerAgentId) {
        const parentAgent = agentManager.getAgent(callerAgentId);
        if (!parentAgent) {
          throw new Error(`Parent agent ${callerAgentId} not found`);
        }
        resolvedCwd = parentAgent.cwd;
        resolvedParentAgentId = callerAgentId;

        const provider: AgentProvider = agentType ?? "claude";
        const parentMode = parentAgent.currentModeId;
        if (parentMode) {
          resolvedMode = mapModeAcrossProviders(
            parentMode,
            parentAgent.provider,
            provider
          );
        }
      } else {
        const topLevelArgs = args as unknown as {
          cwd: string;
          initialMode: string;
          worktreeName?: string;
          baseBranch?: string;
          parentAgentId?: string;
        };
        const {
          cwd,
          initialMode,
          worktreeName,
          baseBranch,
          parentAgentId,
        } = topLevelArgs;

        resolvedCwd = expandPath(cwd);

        if (worktreeName) {
          if (!baseBranch) {
            throw new Error("baseBranch is required when creating a worktree");
          }
          const worktree = await createWorktree({
            branchName: worktreeName,
            cwd: resolvedCwd,
            baseBranch,
            worktreeSlug: worktreeName,
          });
          resolvedCwd = worktree.worktreePath;
        }

        resolvedMode = initialMode;
        resolvedParentAgentId = parentAgentId;
      }

      const provider: AgentProvider = agentType ?? "claude";
      const normalizedTitle = title?.trim() ?? null;
      const snapshot = await agentManager.createAgent({
        provider,
        cwd: resolvedCwd,
        modeId: resolvedMode,
        title: normalizedTitle ?? undefined,
        parentAgentId: resolvedParentAgentId,
      });

      if (initialPrompt) {
        const initialPromptWithInstructions = injectLeadingPaseoInstructionTag(
          initialPrompt,
          snapshot.config.paseoPromptInstructions
        );
        try {
          agentManager.recordUserMessage(snapshot.id, initialPromptWithInstructions);
        } catch (error) {
          childLogger.error(
            { err: error, agentId: snapshot.id },
            "Failed to record initial prompt"
          );
        }

        try {
          startAgentRun(agentManager, snapshot.id, initialPromptWithInstructions, childLogger);

          // If not running in background, wait for completion
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

            const response = {
              content: [],
              structuredContent: validJson,
            };
            return response;
          }
        } catch (error) {
          childLogger.error(
            { err: error, agentId: snapshot.id },
            "Failed to run initial prompt"
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

      // If not running in background, wait for completion
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
          serializeSnapshotWithMetadata(agentRegistry, snapshot, childLogger)
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
    "set_title",
    {
      title: "Set Agent Title",
      description: "Update the agent's title in the registry.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(60)
          .describe("Short descriptive title (<= 60 chars)."),
      },
      outputSchema: {
        success: z.boolean(),
        title: z.string(),
      },
    },
    async ({ title }) => {
      if (!callerAgentId) {
        throw new AgentMcpToolError(
          "NOT_ALLOWED",
          "set_title can only be called by a managed agent"
        );
      }

      const agent = agentManager.getAgent(callerAgentId);
      if (!agent) {
        throw new Error(`Agent ${callerAgentId} not found`);
      }

      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        throw new AgentMcpToolError("NOT_ALLOWED", "Title cannot be empty");
      }
      if (normalizedTitle.length > 60) {
        throw new AgentMcpToolError(
          "NOT_ALLOWED",
          "Title must be 60 characters or fewer"
        );
      }

      await agentManager.setTitle(agent.id, normalizedTitle);
      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          title: normalizedTitle,
        }),
      };
    }
  );

  server.registerTool(
    "set_branch",
    {
      title: "Set Agent Branch",
      description:
        "Rename the current git branch. Allowed only inside Paseo-owned worktrees.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Git branch name (lowercase letters, numbers, hyphens, slashes)."),
      },
      outputSchema: {
        success: z.boolean(),
        branch: z.string(),
      },
    },
    async ({ name }) => {
      if (!callerAgentId) {
        throw new AgentMcpToolError(
          "NOT_ALLOWED",
          "set_branch can only be called by a managed agent"
        );
      }

      const agent = agentManager.getAgent(callerAgentId);
      if (!agent) {
        throw new Error(`Agent ${callerAgentId} not found`);
      }

      const validation = validateBranchSlug(name);
      if (!validation.valid) {
        throw new AgentMcpToolError(
          "INVALID_BRANCH",
          validation.error ?? "Invalid branch name"
        );
      }

      let ownership;
      try {
        ownership = await isPaseoOwnedWorktreeCwd(agent.cwd);
      } catch (error) {
        const notGitError =
          error instanceof NotGitRepoError
            ? error
            : new NotGitRepoError(agent.cwd);
        throw new AgentMcpToolError(
          "NOT_GIT_REPO",
          notGitError.message
        );
      }

      if (!ownership.allowed) {
        throw new AgentMcpToolError(
          "NOT_ALLOWED",
          "Branch renames are only allowed inside Paseo-owned worktrees"
        );
      }

      const result = await renameCurrentBranch(agent.cwd, name);
      if (result.currentBranch !== name) {
        throw new Error(
          `Branch rename failed (expected ${name}, got ${result.currentBranch ?? "unknown"})`
        );
      }

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          branch: name,
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
