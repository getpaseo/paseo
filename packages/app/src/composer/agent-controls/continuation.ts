import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ForkAgentRequest } from "@/hooks/use-fork-agent";

export function selectLiveAgentProviderModel(input: {
  provider: AgentProvider;
  modelId: string;
  currentProvider: string | undefined;
  setCurrentModel: (modelId: string) => Promise<void>;
  continueWithSetup: (setup: ForkAgentRequest["setupOverrides"]) => void;
}): void {
  if (input.provider === input.currentProvider) {
    void input.setCurrentModel(input.modelId);
    return;
  }
  input.continueWithSetup({
    provider: input.provider,
    accountProfileId: undefined,
    model: input.modelId || null,
    modeId: null,
    thinkingOptionId: null,
  });
}
