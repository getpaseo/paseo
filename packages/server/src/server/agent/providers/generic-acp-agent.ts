import type { Logger } from "pino";

import { isCommandAvailable } from "../../../utils/executable.js";
import { ACPAgentClient } from "./acp-agent.js";

interface GenericACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];

  constructor(options: GenericACPAgentClientOptions) {
    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command,
    });

    this.command = options.command;
  }

  protected override async resolveLaunchCommand(): Promise<{ command: string; args: string[] }> {
    return {
      command: this.command[0],
      args: this.command.slice(1),
    };
  }

  override async isAvailable(): Promise<boolean> {
    return isCommandAvailable(this.command[0]);
  }
}
