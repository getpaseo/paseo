import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { McpServerConfig } from "./agent-sdk-types.js";
import { isDeepStrictEqual } from "node:util";

export function mergePluginLaunchContributions(input: {
  pluginId: string;
  servers: Record<string, McpServerConfig>;
  grants: ToolPolicy["preapproved"];
  options: ProviderOptions;
  contribution: {
    mcpServers: Record<string, McpServerConfig>;
    toolPolicy?: ToolPolicy;
    providerOptions?: ProviderOptions;
  };
}): void {
  for (const grant of input.contribution.toolPolicy?.preapproved ?? []) {
    if (grant.server === "paseo" || !Object.hasOwn(input.contribution.mcpServers, grant.server)) {
      throw new Error(
        `Plugin ${input.pluginId} cannot preapprove ${grant.server}.${grant.tool}: server is not contributed by this plugin`,
      );
    }
  }
  for (const [key, value] of Object.entries(input.contribution.providerOptions ?? {})) {
    if (Object.hasOwn(input.options, key) && !isDeepStrictEqual(input.options[key], value)) {
      throw new Error(`Plugin ${input.pluginId} conflicts on launch option ${key}`);
    }
  }
  for (const [key, value] of Object.entries(input.contribution.providerOptions ?? {})) {
    Object.defineProperty(input.options, key, {
      value: structuredClone(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  input.grants.push(...(input.contribution.toolPolicy?.preapproved ?? []));
}
