import type { Logger } from "pino";

import type {
  AgentPermissionResponse,
  AgentPermissionResponseOptions,
  AgentPermissionResult,
} from "./agent-sdk-types.js";
import { startAgentRun, type AgentRunController } from "./agent-prompt.js";

export interface PermissionResponseAgentManager extends AgentRunController {
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    options?: AgentPermissionResponseOptions,
  ): Promise<AgentPermissionResult | void>;
}

export interface RespondToAgentPermissionParams {
  agentManager: PermissionResponseAgentManager;
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
  callerAgentId?: string;
  callerAgentTitle?: string;
  logger: Logger;
}

export async function respondToAgentPermission(
  params: RespondToAgentPermissionParams,
): Promise<void> {
  const { agentManager, agentId, requestId, response, callerAgentId, callerAgentTitle, logger } =
    params;
  logger.debug(
    { agentId, requestId },
    `Handling permission response for agent ${agentId}, request ${requestId}`,
  );

  const responseOptions: AgentPermissionResponseOptions | undefined = callerAgentId
    ? { callerAgentId, ...(callerAgentTitle ? { callerAgentTitle } : {}) }
    : undefined;
  const result = responseOptions
    ? await agentManager.respondToPermission(agentId, requestId, response, responseOptions)
    : await agentManager.respondToPermission(agentId, requestId, response);
  logger.debug({ agentId }, `Permission response forwarded to agent ${agentId}`);

  if (result?.followUpPrompt) {
    logger.debug({ agentId }, "Permission response requires follow-up turn, starting agent stream");
    await startAgentRun(agentManager, agentId, result.followUpPrompt, logger, {
      replaceRunning: true,
    });
  }
}
