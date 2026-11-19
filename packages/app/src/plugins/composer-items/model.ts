import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginComposer } from "@getpaseo/plugin/client";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ComposerModel, ComposerState } from "@/composer/model";
import type { InstalledPlugin } from "../types";
import { createPluginResourceAttachment } from "../attachments/model";
import { cloneAndFreeze, ownCopy } from "../freeze";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";

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

/**
 * What a plugin sees of a composer. Reads are `state`; every command goes to the model, so the
 * mounted composer, a panel's handle and a Command Center item all reach the same one.
 */
export function toPluginComposer(input: {
  plugin: InstalledPlugin;
  model: ComposerModel;
  state: ComposerState;
}): PluginComposer {
  const { plugin, model, state } = input;
  return {
    context: state.context,
    prompt: state.prompt,
    attachments: state.attachments.flatMap((attachment) =>
      attachment.kind === "plugin_resource" && attachment.pluginId === plugin.id
        ? [{ sourceId: attachment.sourceId, item: cloneAndFreeze(attachment.item) }]
        : [],
    ),
    // Provider options are JSON on the wire.
    agent: {
      provider: state.provider,
      model: state.model,
      mode: state.mode,
      thinking: state.thinking,
      options: cloneAndFreeze(state.options as Record<string, JsonValue>),
      metadata: cloneAndFreeze(state.metadata),
    },
    setPrompt: (text) => model.setPrompt(text),
    insertText: (text) => model.insertText(text),
    focus(options) {
      // The Command Center, which may have run this command, gives focus back when it closes.
      clearCommandCenterFocusRestoreElement();
      return model.focus(options);
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
        ownCopy(item),
      );
      model.changeAttachments((current) =>
        current.some((candidate) => isPluginAttachment(candidate, plugin.id, sourceId, item.id))
          ? current
          : [...current, attachment],
      );
    },
    removeAttachment({ sourceId, itemId }) {
      model.changeAttachments((current) =>
        current.filter((candidate) => !isPluginAttachment(candidate, plugin.id, sourceId, itemId)),
      );
    },
    setProvider: (provider) => model.setProvider(provider),
    setModel: (modelId) => model.setModel(modelId),
    setMode: (modeId) => model.setMode(modeId),
    setThinking: (thinkingOptionId) => model.setThinking(thinkingOptionId),
    setOptions: (patch) => model.setOptions(ownCopy(patch)),
    setMetadata: (patch) => model.setMetadata(ownCopy(patch)),
  };
}
