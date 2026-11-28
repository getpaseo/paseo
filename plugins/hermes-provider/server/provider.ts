import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { hermesAcpOptions } from "./acp-options.js";
import { legacyModes } from "./legacy-modes.js";
import { terminalCommand } from "./terminal-command.js";

export function createHermesProvider(): ProviderRegistration {
  return {
    requiresConfiguration: true,
    ...runAcpProvider({
      id: "hermes",
      label: "Hermes",
      description: "Nous Research self-improving AI agent",
      icon: "icon.svg",
      command: ["hermes", "acp"],
      acpOptions: hermesAcpOptions,
      transformers: [terminalCommand, legacyModes],
    }),
  };
}
