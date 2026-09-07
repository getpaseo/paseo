import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import { GenericACPAgentClient } from "../generic-acp-agent.js";
import {
  GROK_MODES,
  readGrokModels,
  transformGrokSessionResponse,
  writeGrokModel,
  writeGrokPermissionMode,
  writeGrokThinkingOption,
} from "./controls.js";

type GrokACPAgentClientOptions = ConstructorParameters<typeof GenericACPAgentClient>[0];

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    const [binary, ...args] = options.command;
    const isolatedArgs = args.filter((arg) => arg !== "--leader" && arg !== "--no-leader");
    const agentIndex = isolatedArgs.indexOf("agent");
    if (agentIndex === -1 || !isolatedArgs.includes("stdio")) {
      throw new GrokLaunchError(options.command);
    }
    isolatedArgs.splice(agentIndex + 1, 0, "--no-leader");
    super({
      ...options,
      command: [binary, ...isolatedArgs],
      nativePermissions: {
        defaultModeId: "ask",
        modes: GROK_MODES,
        write: writeGrokPermissionMode,
      },
      catalogModelResolver: async ({ provider, modelState, configOptions }) =>
        readGrokModels({ provider, modelState, configOptions: configOptions ?? [] }),
      sessionResponseTransformer: transformGrokSessionResponse,
      thinkingOptionWriter: writeGrokThinkingOption,
      providerModelWriter: writeGrokModel,
    });
  }

  protected override buildProbeClient(
    onSessionUpdate?: (params: SessionNotification) => void | Promise<void>,
  ): Client {
    return {
      ...super.buildProbeClient(onSessionUpdate),
      // Grok emits _x.ai/mcp/* notifications during discovery; probes need no UI for them.
      async extNotification() {},
    };
  }
}

class GrokLaunchError extends Error {
  constructor(readonly command: readonly string[]) {
    super(
      `Grok controls require a 'grok agent stdio' command; received ${JSON.stringify(command)}.`,
    );
    this.name = "GrokLaunchError";
  }
}
