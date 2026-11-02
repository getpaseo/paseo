import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginComposer } from "@getpaseo/plugin/client";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ComposerAgent, ComposerInput } from "@/composer/session";
import type { InstalledPlugin } from "../types";
import { createPluginResourceAttachment } from "../attachments/model";
import { cloneAndFreeze } from "../freeze";

function isPluginAttachment(
  attachment: UserComposerAttachment,
  pluginId: string,
  sourceId: string,
  itemId?: string,
): boolean {
  return (
    attachment.kind === "plugin_resource" &&
    attachment.pluginId === pluginId &&
    attachment.sourceId === sourceId &&
    (itemId === undefined || attachment.item.id === itemId)
  );
}

const LOCKED_MESSAGE = "The composer is locked while the agent is being created.";

function assertUnlocked(isLocked: () => boolean): void {
  if (isLocked()) throw new Error(LOCKED_MESSAGE);
}

async function whenUnlocked(agent: ComposerAgent, command: () => Promise<void>): Promise<void> {
  assertUnlocked(agent.isLocked);
  await command();
}

/**
 * What a plugin sees of the composer it sits in. `agent` and `input` are the composer's own
 * halves, so the plugin's commands reach the same models the built-in controls use.
 */
export function toPluginComposer(input: {
  plugin: InstalledPlugin;
  agent: ComposerAgent;
  composerInput: ComposerInput;
  prompt: string;
}): PluginComposer {
  const { plugin, agent, composerInput, prompt } = input;
  return {
    context: agent.context,
    prompt,
    attachments: composerInput.attachments.flatMap((attachment) =>
      attachment.kind === "plugin_resource" && attachment.pluginId === plugin.id
        ? [{ sourceId: attachment.sourceId, item: attachment.item }]
        : [],
    ),
    // Provider options are JSON on the wire.
    agent: {
      provider: agent.provider,
      model: agent.model,
      mode: agent.mode,
      thinking: agent.thinking,
      options: cloneAndFreeze(agent.options as Record<string, JsonValue>),
      metadata: cloneAndFreeze(agent.metadata),
    },
    setPrompt: (text) => {
      assertUnlocked(composerInput.isLocked);
      composerInput.setText(text);
    },
    insertText: (text) => {
      assertUnlocked(composerInput.isLocked);
      composerInput.insertText(text);
    },
    addAttachment({ sourceId, item }) {
      const source = plugin.attachmentSources.find((candidate) => candidate.id === sourceId);
      if (!source) throw new Error(`Unknown attachment source: ${sourceId}`);
      const attachment = createPluginResourceAttachment(
        {
          pluginId: plugin.id,
          sourceId,
          sourceTitle: plugin.i18n.resolve(source.title, plugin.locale),
          sourceIcon: source.icon,
        },
        item,
      );
      composerInput.changeAttachments((current) =>
        current.some((candidate) => isPluginAttachment(candidate, plugin.id, sourceId, item.id))
          ? current
          : [...current, attachment],
      );
    },
    removeAttachment({ sourceId, itemId }) {
      composerInput.changeAttachments((current) =>
        current.filter((candidate) => !isPluginAttachment(candidate, plugin.id, sourceId, itemId)),
      );
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
