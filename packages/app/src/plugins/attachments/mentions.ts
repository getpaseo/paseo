import type { PluginAttachmentItem, PluginAttachmentSourceContribution } from "@getpaseo/plugin";
import type { InstalledPlugin } from "../types";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { createPluginResourceAttachment, type PluginResourceComposerAttachment } from "./model";

export interface AttachmentMentionSource {
  key: string;
  pluginId: string;
  source: PluginAttachmentSourceContribution;
  prefix: string;
}

export interface AttachmentMention {
  source: AttachmentMentionSource;
  query: string;
  mention: FileMentionRange;
}

interface AttachmentMentionEdit {
  text: string;
  selection: { start: number; end: number };
}

interface AttachmentMentionSelection extends AttachmentMentionEdit {
  attachment: PluginResourceComposerAttachment | null;
}

export type AttachmentMentionOption =
  | (AutocompleteOption & {
      type: "plugin_attachment_source";
      source: AttachmentMentionSource;
      mentionQuery: string;
    })
  | (AutocompleteOption & {
      type: "plugin_attachment_item";
      source: AttachmentMentionSource;
      item: PluginAttachmentItem;
      mentionQuery: string;
    });

export function isAttachmentMentionOption(
  option: AutocompleteOption,
): option is AttachmentMentionOption {
  return (
    "type" in option &&
    (option.type === "plugin_attachment_source" || option.type === "plugin_attachment_item")
  );
}

export function collectAttachmentMentionSources(input: {
  plugins: readonly Pick<InstalledPlugin, "id" | "serverId" | "attachmentSources">[];
  serverId: string;
}): AttachmentMentionSource[] {
  const prefixes = new Set<string>();
  const sources: AttachmentMentionSource[] = [];
  for (const plugin of input.plugins) {
    if (plugin.serverId !== input.serverId) continue;
    for (const source of plugin.attachmentSources) {
      const prefix = source.mentionPrefix;
      if (!prefix || prefixes.has(prefix)) continue;
      prefixes.add(prefix);
      sources.push({ key: `${plugin.id}/${source.id}`, pluginId: plugin.id, source, prefix });
    }
  }
  return sources;
}

export function resolveAttachmentMention(input: {
  mention: FileMentionRange | null;
  sources: readonly AttachmentMentionSource[];
}): AttachmentMention | null {
  if (!input.mention) return null;
  const separator = input.mention.query.indexOf(":");
  if (separator < 0) return null;
  const prefix = input.mention.query.slice(0, separator);
  const source = input.sources.find((candidate) => candidate.prefix === prefix);
  if (!source) return null;
  return { source, query: input.mention.query.slice(separator + 1), mention: input.mention };
}

export function replaceAttachmentMention(input: {
  text: string;
  mention: FileMentionRange;
  replacement: string;
}): AttachmentMentionEdit {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  const cursor = before.length + input.replacement.length;
  return {
    text: `${before}${input.replacement}${after}`,
    selection: { start: cursor, end: cursor },
  };
}

export function attachmentMentionOptions(input: {
  sources: readonly AttachmentMentionSource[];
  mention: FileMentionRange | null;
  items: readonly PluginAttachmentItem[];
}): AttachmentMentionOption[] {
  if (!input.mention) return [];
  const mentionQuery = input.mention.query;
  const active = resolveAttachmentMention(input);
  if (active) {
    return input.items.slice(0, 50).map((item) => ({
      id: `plugin-attachment:${active.source.key}/${item.id}`,
      label: `${item.identifier} ${item.title}`,
      description: item.subtitle ?? active.source.source.title,
      type: "plugin_attachment_item",
      source: active.source,
      item,
      mentionQuery,
    }));
  }
  const query = mentionQuery.toLowerCase();
  return input.sources
    .filter(
      (source) =>
        source.prefix.includes(query) || source.source.title.toLowerCase().includes(query),
    )
    .map((source) => ({
      id: `plugin-attachment-source:${source.key}`,
      label: `@${source.prefix}:`,
      description: source.source.title,
      type: "plugin_attachment_source",
      source,
      mentionQuery,
    }));
}

export function selectAttachmentMention(input: {
  option: AttachmentMentionOption;
  text: string;
  mention: FileMentionRange | null;
  scoped: boolean;
}): AttachmentMentionSelection | null {
  if (!input.mention || input.mention.query !== input.option.mentionQuery) return null;
  const { option } = input;
  if (option.type === "plugin_attachment_source") {
    const edit = replaceAttachmentMention({
      text: input.text,
      mention: input.mention,
      replacement: `@${option.source.prefix}:`,
    });
    return { ...edit, attachment: null };
  }
  if (!input.scoped) return null;
  const attachment = createPluginResourceAttachment(
    {
      pluginId: option.source.pluginId,
      sourceId: option.source.source.id,
      sourceTitle: option.source.source.title,
      sourceIcon: option.source.source.icon,
    },
    option.item,
  );
  const edit = replaceAttachmentMention({
    text: input.text,
    mention: input.mention,
    replacement: "",
  });
  return { ...edit, attachment };
}
