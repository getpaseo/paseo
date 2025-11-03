import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "os";
import { resolve } from "path";
import { AgentManager } from "./agent-manager.js";
import type { AgentNotification } from "./types.js";
import { curateAgentActivity } from "./activity-curator.js";
import {
  listAgentTypeDefinitions,
  type AgentType,
} from "./agent-types.js";

export interface AgentMcpServerOptions {
  agentManager: AgentManager;
}

/**
 * Expand tilde (~) to home directory and resolve path
 */
function expandPath(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Extract the update type from an AgentNotification
 */
function getUpdateType(notification: AgentNotification): string {
  if (notification.type === 'session') {
    return notification.notification.update.sessionUpdate;
  }
  return notification.type;
}

/**
 * Serialize AgentInfo for MCP output (convert Date to string for JSON compatibility)
 */
function serializeAgentInfo(info: any): any {
  return {
    ...info,
    createdAt: info.createdAt.toISOString(),
    lastActivityAt: info.lastActivityAt.toISOString(),
  };
}

/**
 * Create and configure the Agent MCP Server
 * Exposes Claude Code agent management tools to the LLM
 */
export async function createAgentMcpServer(
  options: AgentMcpServerOptions
): Promise<McpServer> {
  const { agentManager } = options;

  const agentTypeDefinitions = listAgentTypeDefinitions();
  if (agentTypeDefinitions.length === 0) {
    throw new Error("[Agent MCP] No agent types configured");
  }

  const agentTypeIds = agentTypeDefinitions.map(
    (definition) => definition.id
  ) as [AgentType, ...AgentType[]];

  const AgentTypeEnum = z.enum(agentTypeIds);

  const server = new McpServer({
    name: "agent-mcp",
    version: "1.0.0",
  });

  // Tool: create_coding_agent
  server.registerTool(
    "create_coding_agent",
    {
      title: "Create Coding Agent",
      description:
        "Creates a new Claude Code or Codex agent via ACP. The agent runs as a separate process and can execute coding tasks autonomously in a specified directory. Returns immediately with agent ID, type, and status. If an initial prompt is provided, the agent will start working on it automatically. Optionally create a git worktree for isolated development.",
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "REQUIRED: Working directory for the agent. Can be absolute path, tilde-prefixed path, or relative path (e.g., '~/dev/project', '/path/to/repo', './subdir')."
          ),
        agentType: AgentTypeEnum.optional().describe(
          "Optional: Agent implementation to spawn. 'claude' provides full Claude Code capabilities with session persistence. 'codex' uses Zed Codex ACP with fast startup and explicit permission modes. Defaults to 'claude'."
        ),
        initialPrompt: z
          .string()
          .optional()
          .describe(
            "Optional initial task or prompt for the agent to start working on immediately after creation. If provided, agent will begin processing this task right away."
          ),
        initialMode: z.string().optional().describe(
          "Optional: Initial session mode for the agent. Mode is validated at runtime based on agent type. Claude Code supports 'default', 'plan', and 'bypassPermissions'. Codex supports 'read-only', 'auto', and 'full-access'. Defaults to the agent type's default mode."
        ),
        worktreeName: z
          .string()
          .optional()
          .describe(
            "Optional git worktree branch name for isolated development. Must be a valid slug: lowercase letters, numbers, and hyphens only (e.g., 'feature-auth', 'fix-bug-123'). Creates a new git worktree with this branch name and runs the agent in the worktree directory. Only works if cwd is inside a git repository."
          ),
      },
      outputSchema: {
        agentId: z.string().describe("Unique identifier for the created agent"),
        type: AgentTypeEnum.describe("Agent implementation that was created"),
        status: z
          .string()
          .describe(
            "Current agent status: 'initializing', 'ready', 'processing', etc."
          ),
        cwd: z.string().describe("The resolved absolute working directory the agent is running in (worktree path if worktreeName was provided)"),
        currentModeId: z.string().nullable().describe("The agent's current session mode"),
        availableModes: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable().optional(),
        })).nullable().describe("Available session modes for this agent"),
      },
    },
    async ({ cwd, agentType, initialPrompt, initialMode, worktreeName }) => {
      // Expand and resolve the working directory
      let resolvedCwd = expandPath(cwd);

      // Handle worktree creation if requested
      if (worktreeName) {
        const { createWorktree } = await import("../../utils/worktree.js");
        
        const worktreeConfig = await createWorktree({
          branchName: worktreeName,
          cwd: resolvedCwd,
        });

        resolvedCwd = worktreeConfig.worktreePath;
      }

      const resolvedType: AgentType = agentType ?? "claude";

      const agentId = await agentManager.createAgent({
        cwd: resolvedCwd,
        type: resolvedType,
        initialPrompt,
        initialMode,
      });

      const status = agentManager.getAgentStatus(agentId);
      const currentModeId = agentManager.getCurrentMode(agentId);
      const availableModes = agentManager.getAvailableModes(agentId);

      const result = {
        agentId,
        type: resolvedType,
        status,
        cwd: resolvedCwd,
        currentModeId: currentModeId ?? null,
        availableModes: availableModes ?? null,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: wait_for_agent
  server.registerTool(
    "wait_for_agent",
    {
      title: "Wait For Agent",
      description:
        "Wait until the agent requests permission or finishes its task. Returns the agent's activity and permission request (if any). Use this to monitor agent progress without polling.",
      inputSchema: {
        agentId: z
          .string()
          .describe("Agent ID to wait on (typically the result of create_coding_agent)"),
      },
      outputSchema: {
        agentId: z.string(),
        status: z
          .string()
          .describe("Agent status after waiting completed"),
        permission: z.object({
          agentId: z.string(),
          requestId: z.string(),
          sessionId: z.string(),
          toolCall: z.any(),
          options: z.array(
            z.object({
              kind: z.string(),
              name: z.string(),
              optionId: z.string(),
            })
          ),
        }).nullable().describe("Permission request if agent requested one, null if agent finished without requesting"),
        activity: z.object({
          format: z
            .literal("curated")
            .describe("Activity format: curated text for easy reading"),
          updateCount: z
            .number()
            .describe("Total number of updates recorded for the agent"),
          currentModeId: z
            .string()
            .nullable()
            .describe("Current session mode"),
          content: z
            .string()
            .describe("Curated activity transcript including the latest updates"),
        }),
      },
    },
    async ({ agentId }, { signal }) => {
      const permission = await agentManager.waitForPermissionRequest(agentId, {
        signal,
      });
      const updates = agentManager.getAgentUpdates(agentId);
      const curatedText = curateAgentActivity(updates);
      const currentModeId = agentManager.getCurrentMode(agentId);
      const status = agentManager.getAgentStatus(agentId);

      return {
        content: [],
        structuredContent: {
          agentId,
          status,
          permission,
          activity: {
            format: "curated" as const,
            updateCount: updates.length,
            currentModeId,
            content: curatedText,
          },
        },
      };
    }
  );

  // Tool: send_agent_prompt
  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send Agent Prompt",
      description:
        "Sends a task or prompt to an existing agent. Returns immediately without waiting (non-blocking). The agent will process the prompt in the background. Use wait_for_agent, get_agent_status, or get_agent_activity to monitor progress. Optionally switch session modes before sending.",
      inputSchema: {
        agentId: z.string().describe("Agent ID returned from create_coding_agent"),
        prompt: z
          .string()
          .describe(
            "The task, instruction, or feedback to send to the agent. Be specific about what you want the agent to accomplish."
          ),
        sessionMode: z.string().optional().describe(
          "Optional: Session mode to set before sending the prompt. Mode is validated at runtime based on agent type. Claude Code supports 'default', 'plan', and 'bypassPermissions'. Codex offers 'read-only', 'auto', and 'full-access' for progressively broader permissions."
        ),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the prompt was sent successfully"),
        status: z
          .string()
          .describe("Agent status immediately after enqueuing the prompt (usually 'processing')"),
      },
    },
    async ({ agentId, prompt, sessionMode }) => {
      await agentManager.sendPrompt(agentId, prompt, {
        sessionMode,
      });

      const result = {
        success: true,
        status: agentManager.getAgentStatus(agentId),
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: get_agent_status
  server.registerTool(
    "get_agent_status",
    {
      title: "Get Agent Status",
      description:
        "Get the current status and information about a specific agent. Returns status, creation time, session ID, and any error messages.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to query"),
      },
      outputSchema: {
        status: z.string().describe("Current agent status"),
        info: z
          .object({
            id: z.string(),
            status: z.string(),
            createdAt: z.string(),
            lastActivityAt: z.string(),
            type: AgentTypeEnum,
            sessionId: z.string().nullable(),
            error: z.string().nullable(),
            currentModeId: z.string().nullable(),
            availableModes: z.array(z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable().optional(),
            })).nullable(),
          })
          .describe("Detailed agent information"),
      },
    },
    async ({ agentId }) => {
      const status = agentManager.getAgentStatus(agentId);
      const agents = agentManager.listAgents();
      const agentInfo = agents.find((a) => a.id === agentId);

      if (!agentInfo) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const result = {
        status,
        info: serializeAgentInfo(agentInfo),
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: list_agents
  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description:
        "List all active agents managed by this session. Shows agent IDs, statuses, creation times, and any errors. Useful for monitoring multiple concurrent agents.",
      inputSchema: {},
      outputSchema: {
        agents: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            createdAt: z.string(),
            lastActivityAt: z.string(),
            type: AgentTypeEnum,
            sessionId: z.string().nullable(),
            error: z.string().nullable(),
            currentModeId: z.string().nullable(),
            availableModes: z.array(z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable().optional(),
            })).nullable(),
          })
        ),
      },
    },
    async () => {
      const agents = agentManager.listAgents();

      const result = {
        agents: agents.map(serializeAgentInfo),
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: cancel_agent
  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel Agent",
      description:
        "Cancel the current task of a running agent. The agent remains alive and returns to 'ready' state, allowing you to send new prompts. Use this when you want to interrupt an agent's work without killing it.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to cancel"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether cancellation succeeded"),
      },
    },
    async ({ agentId }) => {
      await agentManager.cancelAgent(agentId);

      const result = {
        success: true,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: kill_agent
  server.registerTool(
    "kill_agent",
    {
      title: "Kill Agent",
      description:
        "Terminate an agent completely. This kills the agent's process and removes it from the manager. The agent cannot be used after this operation. Use this when you're done with an agent or if it's in a failed state.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to kill"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the agent was killed successfully"),
      },
    },
    async ({ agentId }) => {
      await agentManager.killAgent(agentId);

      const result = {
        success: true,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: get_agent_activity
  server.registerTool(
    "get_agent_activity",
    {
      title: "Get Agent Activity",
      description:
        "Get the agent's activity in a human-readable, token-efficient format. Consolidates message chunks, formats tool calls, and structures plans. By default returns curated text, but you can request raw updates with format='raw'.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to query"),
        format: z
          .enum(["curated", "raw"])
          .optional()
          .default("curated")
          .describe(
            "Output format: 'curated' (default) for clean human-readable text, 'raw' for detailed JSON updates"
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "Maximum number of updates to include (most recent first). Only applies to 'raw' format. Omit to get all updates."
          ),
      },
      outputSchema: {
        agentId: z.string(),
        format: z.enum(["curated", "raw"]),
        updateCount: z.number().describe("Total number of updates available"),
        currentModeId: z.string().nullable().describe("Current session mode of the agent"),
        content: z.string().describe("Formatted activity content (if curated) or empty string (if raw)"),
        updates: z.array(
          z.object({
            timestamp: z.string(),
            type: z.string(),
            data: z.any(),
          })
        ).nullable().describe("Raw updates array (if raw format) or null (if curated)"),
      },
    },
    async ({ agentId, format = "curated", limit }) => {
      const updates = await agentManager.getAgentUpdates(agentId);
      const currentModeId = agentManager.getCurrentMode(agentId);

      if (format === "curated") {
        // Return curated, human-readable format
        const curatedText = curateAgentActivity(updates);

        return {
          content: [],
          structuredContent: {
            agentId,
            format: "curated" as const,
            updateCount: updates.length,
            currentModeId,
            content: curatedText,
            updates: null,
          },
        };
      } else {
        // Return raw format (old behavior)
        const selectedUpdates = limit
          ? updates.slice(-limit).reverse()
          : updates;

        return {
          content: [],
          structuredContent: {
            agentId,
            format: "raw" as const,
            updateCount: updates.length,
            currentModeId,
            content: "",
            updates: selectedUpdates.map((update) => ({
              timestamp: update.timestamp.toISOString(),
              type: getUpdateType(update.notification),
              data: update.notification,
            })),
          },
        };
      }
    }
  );

  // Tool: set_agent_mode
  server.registerTool(
    "set_agent_mode",
    {
      title: "Set Agent Session Mode",
      description:
        "Change the agent's session mode. Claude Code supports 'plan' for step-by-step approvals and 'bypassPermissions' to auto-approve actions. Codex offers 'read-only', 'auto', and 'full-access' to control how freely it can modify the workspace or access the system. Use get_agent_status or list_agents to see which modes are currently available for each agent.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to configure"),
        modeId: z.string().describe(
          "The session mode to set. Mode is validated at runtime based on the agent's available modes. Check agent's availableModes from get_agent_status or list_agents to see valid options for the specific agent."
        ),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the mode change succeeded"),
        previousMode: z.string().nullable().describe("The previous session mode"),
        newMode: z.string().describe("The new session mode"),
      },
    },
    async ({ agentId, modeId }) => {
      const previousMode = agentManager.getCurrentMode(agentId);
      await agentManager.setSessionMode(agentId, modeId);

      const result = {
        success: true,
        previousMode: previousMode ?? null,
        newMode: modeId,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: list_pending_permissions
  server.registerTool(
    "list_pending_permissions",
    {
      title: "List Pending Permission Requests",
      description:
        "Get all pending permission requests from agents. When an agent in plan mode calls ExitPlanMode, or when an agent needs permission for file operations or commands, it creates a permission request. This tool shows all requests waiting for approval across all agents. Use respond_to_permission to approve or reject them.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string().describe("Agent that requested permission"),
            requestId: z.string().describe("Unique identifier for this permission request"),
            sessionId: z.string().describe("Agent's session ID"),
            toolCall: z.any().describe("The tool call that triggered the permission request (contains details like plan, file_path, command, etc.)"),
            options: z.array(
              z.object({
                kind: z.string().describe("Option kind: 'allow_always', 'allow_once', 'reject_once'"),
                name: z.string().describe("Human-readable option name"),
                optionId: z.string().describe("Option ID to use when responding"),
              })
            ).describe("Available response options"),
          })
        ).describe("List of all pending permission requests"),
      },
    },
    async () => {
      const permissions = agentManager.getPendingPermissions();

      const result = {
        permissions,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: respond_to_permission
  server.registerTool(
    "respond_to_permission",
    {
      title: "Respond to Permission Request",
      description:
        "Approve or reject a pending permission request from an agent. When an agent requests permission (e.g., to exit plan mode, create a file, or run a command), you can use this tool to respond with your decision. The agent will proceed based on your response.",
      inputSchema: {
        agentId: z.string().describe("Agent ID (from list_pending_permissions)"),
        requestId: z.string().describe("Permission request ID (from list_pending_permissions)"),
        optionId: z.string().describe("Option ID to select (e.g., 'allow', 'reject', 'plan'). Get available options from list_pending_permissions."),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the response was successfully sent to the agent"),
      },
    },
    async ({ agentId, requestId, optionId }) => {
      agentManager.respondToPermission(agentId, requestId, optionId);

      const result = {
        success: true,
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  return server;
}
