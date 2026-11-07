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
 * The provider's own configured environment.
 *
 * The key a user configured for the provider lives in
 * `agents.providers.<id>.env`, which the daemon holds as the provider's
 * runtime settings. The hook that injects the ZCode key runs before those
 * settings are merged into the child process, so the injected key would
 * replace the configured one.
 */
export interface ProviderSettingsReader {
  /** The environment the user configured for the provider, if any. */
  providerEnv(providerId: string): Promise<Record<string, string> | undefined>;
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
  providerSettings?: ProviderSettingsReader,
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

  // The key the user configured for the provider wins over the ZCode account:
  // it is the account they picked, and its quota is the one they track.
  const configured = await providerSettings?.providerEnv(GLM_ACP_PROVIDER_ID);
  if (configured?.[Z_AI_API_KEY_ENV]?.trim()) {
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
