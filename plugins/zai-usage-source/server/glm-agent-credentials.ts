import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { readZCodeApiKey } from "./zcode-credentials.js";

/**
 * The ACP provider that drives Zhipu AI's GLM Coding Plan models.
 *
 * The agent reads its key from `Z_AI_API_KEY` or from the credentials file its
 * `--setup` writes. Neither is present when the account is signed in through the
 * ZCode desktop app, which keeps the same Coding Plan key in its own store.
 */
const GLM_ACP_PROVIDER_ID = "glm-acp-agent";

/** The variable the agent reads the API key from. */
export const Z_AI_API_KEY_ENV = "Z_AI_API_KEY";

export interface AgentCreateEnvRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
}

/**
 * Adds the Coding Plan key to the environment of a GLM ACP agent.
 *
 * The key is only added when the agent would otherwise start without one, and
 * never overwrites a key the user configured themselves.
 */
export async function injectGlmApiKey(
  request: AgentCreateEnvRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentCreateEnvRequest> {
  if (request.config.provider !== GLM_ACP_PROVIDER_ID) {
    return request;
  }

  const currentEnv = request.env ?? {};
  if (currentEnv[Z_AI_API_KEY_ENV]?.trim()) {
    return request;
  }
  if (env[Z_AI_API_KEY_ENV]?.trim()) {
    return request;
  }

  const apiKey = await readZCodeApiKey(env);
  if (!apiKey) {
    return request;
  }

  return {
    ...request,
    env: { ...currentEnv, [Z_AI_API_KEY_ENV]: apiKey },
  };
}
