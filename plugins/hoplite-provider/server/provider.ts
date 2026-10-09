import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { runPhaseTransformer } from "./run-phase.js";

export function createHopliteProvider(): ProviderRegistration {
  return runAcpProvider({
    id: "hoplite",
    label: "Hoplite",
    description: "Hoplite's coding agent through the local `hoplite acp` bridge",
    icon: "icon.svg",
    command: ["hoplite", "acp"],
    transformers: [runPhaseTransformer],
  });
}
