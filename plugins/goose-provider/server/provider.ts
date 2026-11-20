import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { gooseModels } from "./models.js";

export function createGooseProvider(): ProviderRegistration {
  return {
    requiresConfiguration: true,
    ...runAcpProvider({
      id: "goose",
      label: "goose",
      description: "A local, extensible, open source AI agent that automates engineering tasks",
      icon: "icon.svg",
      command: ["goose", "acp"],
      transformers: [gooseModels],
    }),
  };
}
