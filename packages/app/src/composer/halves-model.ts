import type { ComposerAgent, ComposerInput } from "@/composer/session";
import type { ComposerModel, ComposerState } from "@/composer/model";

const LOCKED_MESSAGE = "The composer is locked while the agent is being created.";

function assertUnlocked(isLocked: () => boolean): void {
  if (isLocked()) throw new Error(LOCKED_MESSAGE);
}

async function whenUnlocked(agent: ComposerAgent, command: () => Promise<void>): Promise<void> {
  assertUnlocked(agent.isLocked);
  await command();
}

/**
 * The model of a draft or New workspace composer, built from the two halves its mounted
 * composer provides. Its state belongs to the render that built it, so a change is a new model;
 * only the prompt changes underneath it.
 */
export function composerModelFromHalves(input: {
  agent: ComposerAgent;
  input: ComposerInput;
}): ComposerModel {
  const { agent, input: composerInput } = input;
  let last: ComposerState | null = null;
  return {
    getState() {
      const prompt = composerInput.textSource.getSnapshot();
      if (last && last.prompt === prompt) return last;
      last = {
        context: agent.context,
        prompt,
        attachments: composerInput.attachments,
        provider: agent.provider,
        model: agent.model,
        mode: agent.mode,
        thinking: agent.thinking,
        options: agent.options,
        metadata: agent.metadata,
      };
      return last;
    },
    subscribe: composerInput.textSource.subscribe,
    setPrompt(text) {
      assertUnlocked(composerInput.isLocked);
      composerInput.setText(text);
    },
    insertText(text) {
      assertUnlocked(composerInput.isLocked);
      composerInput.insertText(text);
    },
    // Only an item inside this composer can hold it, so the user was here when they asked. Paseo
    // has no way to name a draft from outside it and does not pull the user back to one.
    async focus(options) {
      if (!composerInput.isRevealed()) throw new Error("The composer is not on screen.");
      await composerInput.focus(options);
    },
    changeAttachments(updater) {
      assertUnlocked(composerInput.isLocked);
      composerInput.changeAttachments(updater);
    },
    setProvider: (provider) => whenUnlocked(agent, () => agent.setProvider(provider)),
    setModel: (modelId) => whenUnlocked(agent, () => agent.setModel(modelId)),
    setMode: (modeId) => whenUnlocked(agent, () => agent.setMode(modeId)),
    setThinking: (thinkingOptionId) =>
      whenUnlocked(agent, () => agent.setThinking(thinkingOptionId)),
    setOptions: (patch) => whenUnlocked(agent, () => agent.setOptions(patch)),
    setMetadata: (patch) => whenUnlocked(agent, () => agent.setMetadata(patch)),
  };
}
