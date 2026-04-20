import type { Logger } from "pino";

import { isCommandAvailable } from "../../../utils/executable.js";
import { ACPAgentClient } from "./acp-agent.js";

type GenericACPAgentClientOptions = {
  logger: Logger;
  command: string[];
  env?: Record<string, string>;
};

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];

  constructor(options: GenericACPAgentClientOptions) {
    if (options.command.length === 0) {
      throw new Error("Generic ACP provider requires a non-empty command");
    }

    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command as [string, ...string[]],
    });

    this.command = options.command as [string, ...string[]];
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
