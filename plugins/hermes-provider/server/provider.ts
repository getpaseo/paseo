import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
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
      acpOptions: {
        autoAcceptMode: {
          mode: {
            id: "full-access",
            label: "Full access",
            description: "Approve tool requests without asking.",
            icon: "ShieldOff",
            colorTier: "dangerous",
          },
          nativeMode: "ask",
        },
      },
      transformers: [terminalCommand, legacyModes],
    }),
  };
}
