/**
 * Agent Self-ID MCP Server
 *
 * Purpose: Agents identifying themselves (title, branch)
 * Transport: Stdio bridge → Unix socket (${PASEO_HOME}/self-id-mcp.sock)
 * Server name: "paseo-agent-self-id"
 *
 * Tools:
 * - set_title - Set agent's display title
 * - set_branch - Rename git branch (Paseo worktrees only)
 *
 * Requires callerAgentId - must know which agent is calling.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureValidJson } from "../json-utils.js";
import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import {
  isPaseoOwnedWorktreeCwd,
  validateBranchSlug,
} from "../../utils/worktree.js";
import {
  NotGitRepoError,
  renameCurrentBranch,
} from "../../utils/checkout-git.js";

export interface AgentSelfIdMcpOptions {
  agentManager: AgentManager;
  paseoHome?: string;
  /**
   * ID of the agent that is connecting to this MCP server.
   * Required - this server only works for managed agents.
   */
  callerAgentId: string;
  logger: Logger;
}

type ToolErrorCode = "NOT_ALLOWED" | "NOT_GIT_REPO" | "INVALID_BRANCH";

class AgentSelfIdToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "AgentSelfIdToolError";
    this.code = code;
  }
}

export async function createAgentSelfIdMcpServer(
  options: AgentSelfIdMcpOptions
): Promise<McpServer> {
  const { agentManager, callerAgentId, logger } = options;
  const childLogger = logger.child({
    module: "agent",
    component: "agent-self-id-mcp",
    callerAgentId,
  });

  const server = new McpServer({
    name: "paseo-agent-self-id",
    version: "1.0.0",
  });

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
      const agent = agentManager.getAgent(callerAgentId);
      if (!agent) {
        throw new Error(`Agent ${callerAgentId} not found`);
      }

      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        throw new AgentSelfIdToolError("NOT_ALLOWED", "Title cannot be empty");
      }
      if (normalizedTitle.length > 60) {
        throw new AgentSelfIdToolError(
          "NOT_ALLOWED",
          "Title must be 60 characters or fewer"
        );
      }

      childLogger.debug({ title: normalizedTitle }, "Setting agent title");
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
          .describe(
            "Git branch name (lowercase letters, numbers, hyphens, slashes)."
          ),
      },
      outputSchema: {
        success: z.boolean(),
        branch: z.string(),
      },
    },
    async ({ name }) => {
      const agent = agentManager.getAgent(callerAgentId);
      if (!agent) {
        throw new Error(`Agent ${callerAgentId} not found`);
      }

      const validation = validateBranchSlug(name);
      if (!validation.valid) {
        throw new AgentSelfIdToolError(
          "INVALID_BRANCH",
          validation.error ?? "Invalid branch name"
        );
      }

      let ownership;
      try {
        ownership = await isPaseoOwnedWorktreeCwd(agent.cwd, {
          paseoHome: options.paseoHome,
        });
      } catch (error) {
        const notGitError =
          error instanceof NotGitRepoError
            ? error
            : new NotGitRepoError(agent.cwd);
        throw new AgentSelfIdToolError("NOT_GIT_REPO", notGitError.message);
      }

      if (!ownership.allowed) {
        throw new AgentSelfIdToolError(
          "NOT_ALLOWED",
          "Branch renames are only allowed inside Paseo-owned worktrees"
        );
      }

      childLogger.debug({ branch: name }, "Renaming branch");
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

  return server;
}
