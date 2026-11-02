import type { ComposerAgent } from "@/composer/session";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";

/**
 * The agent a draft composer creates, as a plugin sees it. Its commands go to the form and the
 * options model, which apply them as they run, so a plugin can `await` one and issue the next.
 */
export function draftComposerAgent(
  props: Pick<
    DraftAgentControlsProps,
    | "context"
    | "selectedProvider"
    | "selectedModel"
    | "selectedMode"
    | "options"
    | "metadata"
    | "onSelectProviderAndModel"
    | "onSelectModel"
    | "onSelectMode"
    | "onSelectThinkingOption"
    | "onSetOption"
    | "onSetMetadata"
  > & { thinking: string | null },
): ComposerAgent {
  return {
    context: props.context ?? "draft",
    provider: props.selectedProvider,
    model: props.selectedModel || null,
    mode: props.selectedMode || null,
    thinking: props.thinking,
    options: props.options,
    metadata: props.metadata,
    // An empty model id picks the provider's default model.
    setProvider: async (provider) => {
      if (!props.onSelectProviderAndModel(provider, "")) {
        throw new Error(`Unknown or unavailable provider: ${provider}`);
      }
    },
    setModel: async (modelId) => {
      if (!props.onSelectModel(modelId)) throw new Error(`Unknown model: ${modelId}`);
    },
    setMode: async (modeId) => props.onSelectMode(modeId),
    setThinking: async (thinkingOptionId) => props.onSelectThinkingOption(thinkingOptionId),
    setOptions: async (patch) => {
      for (const [key, value] of Object.entries(patch)) props.onSetOption(key, value);
    },
    setMetadata: async (patch) => props.onSetMetadata(patch),
  };
}
