import type { Logger } from "pino";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { ProviderRegistration } from "@getpaseo/plugin/provider";

import type { AgentClient, AgentProvider } from "../agent-sdk-types.js";
import type { ProviderProfileModel } from "../provider-launch-config.js";
import { ToolPolicyUnsupportedError } from "../provider-options.js";
import { CursorACPAgentClient } from "./cursor-acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { KimiACPAgentClient } from "./kimi-acp-agent.js";
import { KiroACPAgentClient } from "./kiro-acp-agent.js";
import { TraeACPAgentClient } from "./trae-acp-agent.js";
import { createClientProviderRegistration } from "./native/registration-factory.js";

export interface AcpRegistrationSource {
  provider: AgentProvider;
  definition: AgentProviderDefinition;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerParams?: unknown;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
}

const HUB_E2E_PROVIDER_ID = "hub-e2e";
const HUB_E2E_MCP_SERVER = "hub";
const HUB_E2E_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export function createAcpProviderRegistration(
  logger: Logger,
  source: AcpRegistrationSource,
): ProviderRegistration {
  return createClientProviderRegistration({
    logger,
    provider: source.provider,
    definition: source.definition,
    profileModels: source.profileModels,
    additionalModels: source.additionalModels,
    profileModelsAreAdditive: false,
    createClient: () => createAcpClient(logger, source),
    prepareToolPolicy:
      source.provider === HUB_E2E_PROVIDER_ID ? prepareHubE2eToolPolicy : undefined,
  });
}

function createAcpClient(logger: Logger, source: AcpRegistrationSource): AgentClient {
  const options = {
    logger,
    command: source.command,
    env: source.env,
    providerId: source.provider,
    label: source.definition.label,
    providerParams: source.providerParams,
  };
  switch (source.provider) {
    case "cursor":
      return new CursorACPAgentClient(options);
    case "kimi":
      return new KimiACPAgentClient(options);
    case "kiro":
      return new KiroACPAgentClient(options);
    case "traecli":
      return new TraeACPAgentClient(options);
    default:
      return new GenericACPAgentClient(options);
  }
}

function prepareHubE2eToolPolicy(provider: string, toolPolicy: ToolPolicy): ToolPolicy {
  for (const grant of toolPolicy.preapproved) {
    if (
      grant.kind !== "mcp" ||
      grant.server !== HUB_E2E_MCP_SERVER ||
      !HUB_E2E_TOOL_NAME.test(grant.tool)
    ) {
      throw new ToolPolicyUnsupportedError(
        provider,
        `Provider '${provider}' accepts only exact MCP tool grants for the injected '${HUB_E2E_MCP_SERVER}' server`,
      );
    }
  }
  return { preapproved: toolPolicy.preapproved.map((grant) => ({ ...grant })) };
}
