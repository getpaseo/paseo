import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "os";
import { resolve } from "path";
import { AgentManager } from "./agent-manager.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";

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
 * Extract the update type from a SessionNotification
 */
function getUpdateType(notification: SessionNotification): string {
  return notification.update.sessionUpdate;
}

/**
 * Create and configure the Agent MCP Server
 * Exposes Claude Code agent management tools to the LLM
 */
export async function createAgentMcpServer(
  options: AgentMcpServerOptions
): Promise<McpServer> {
  const { agentManager } = options;

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
        "Creates a new Claude Code agent via ACP. The agent runs as a separate process and can execute coding tasks autonomously in a specified directory. Returns immediately with agent ID and status. If an initial prompt is provided, the agent will start working on it automatically.",
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "REQUIRED: Working directory for the agent. Can be absolute path, tilde-prefixed path, or relative path (e.g., '~/dev/project', '/path/to/repo', './subdir')."
          ),
        initialPrompt: z
          .string()
          .optional()
          .describe(
            "Optional initial task or prompt for the agent to start working on immediately after creation. If provided, agent will begin processing this task right away."
          ),
        initialMode: z
          .string()
          .optional()
          .describe(
            "Initial session mode for the agent (e.g., 'ask', 'code', 'architect'). If not specified, the agent will use its default mode. The available modes depend on the specific agent implementation."
          ),
      },
      outputSchema: {
        agentId: z.string().describe("Unique identifier for the created agent"),
        status: z
          .string()
          .describe(
            "Current agent status: 'initializing', 'ready', 'processing', etc."
          ),
        cwd: z.string().describe("The resolved absolute working directory the agent is running in"),
        currentModeId: z.string().nullable().describe("The agent's current session mode"),
        availableModes: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
        })).nullable().describe("Available session modes for this agent"),
      },
    },
    async ({ cwd, initialPrompt, initialMode }) => {
      // Expand and resolve the working directory
      const resolvedCwd = expandPath(cwd);

      const agentId = await agentManager.createAgent({
        cwd: resolvedCwd,
        initialPrompt,
        initialMode,
      });

      const status = agentManager.getAgentStatus(agentId);
      const currentModeId = agentManager.getCurrentMode(agentId);
      const availableModes = agentManager.getAvailableModes(agentId);

      const result = {
        agentId,
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

  // Tool: send_agent_prompt
  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send Agent Prompt",
      description:
        "Sends a task or prompt to an existing agent. The agent will process the prompt and execute the required actions. Use this to give the agent new tasks, provide feedback, or steer its work. Only works if agent is in 'ready' or 'completed' state.",
      inputSchema: {
        agentId: z.string().describe("Agent ID returned from create_coding_agent"),
        prompt: z
          .string()
          .describe(
            "The task, instruction, or feedback to send to the agent. Be specific about what you want the agent to accomplish."
          ),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the prompt was sent successfully"),
      },
    },
    async ({ agentId, prompt }) => {
      await agentManager.sendPrompt(agentId, prompt);

      const result = {
        success: true,
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
            createdAt: z.date(),
            type: z.literal("claude"),
            sessionId: z.string().nullable(),
            error: z.string().nullable(),
            currentModeId: z.string().nullable(),
            availableModes: z.array(z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().optional(),
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
        info: agentInfo,
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
            createdAt: z.date(),
            type: z.literal("claude"),
            sessionId: z.string().nullable(),
            error: z.string().nullable(),
            currentModeId: z.string().nullable(),
            availableModes: z.array(z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().optional(),
            })).nullable(),
          })
        ),
      },
    },
    async () => {
      const agents = agentManager.listAgents();

      const result = {
        agents,
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
        "Get the complete activity log for an agent, including all messages, tool calls, and results. This shows you everything the agent has done - what it said, what tools it called, and what output it produced. Essential for understanding what a completed or failed agent actually accomplished.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to query"),
        limit: z
          .number()
          .optional()
          .describe(
            "Maximum number of updates to return (most recent first). Omit to get all updates."
          ),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number().describe("Total number of updates"),
        updates: z.array(
          z.object({
            timestamp: z.string(),
            type: z.string(),
            data: z.any(),
          })
        ),
      },
    },
    async ({ agentId, limit }) => {
      const updates = agentManager.getAgentUpdates(agentId);

      // Get the most recent updates if limit is specified
      const selectedUpdates = limit
        ? updates.slice(-limit).reverse()
        : updates;

      const result = {
        agentId,
        updateCount: updates.length,
        updates: selectedUpdates.map((update) => ({
          timestamp: update.timestamp.toISOString(),
          type: getUpdateType(update.notification),
          data: update.notification,
        })),
      };

      return {
        content: [],
        structuredContent: result,
      };
    }
  );

  // Tool: set_agent_mode
  server.registerTool(
    "set_agent_mode",
    {
      title: "Set Agent Session Mode",
      description:
        "Change the agent's session mode (e.g., from 'ask' to 'code', or 'architect' to 'code'). Each mode affects the agent's behavior - 'ask' mode requests permission before changes, 'code' mode writes code directly, 'architect' mode plans without implementation. The available modes depend on the specific agent. Use get_agent_status or list_agents to see available modes for each agent.",
      inputSchema: {
        agentId: z.string().describe("Agent ID to configure"),
        modeId: z
          .string()
          .describe(
            "The session mode to set (e.g., 'ask', 'code', 'architect'). Must be one of the agent's available modes."
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

  return server;
}
