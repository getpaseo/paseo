import { describe, expect, it } from "vitest";
import { defineRpc, type PluginAttachmentSourceContribution } from "@getpaseo/plugin";
import { z } from "zod";
import {
  collectAttachmentMentionSources,
  resolveAttachmentMention,
  replaceAttachmentMention,
  attachmentMentionOptions,
  selectAttachmentMention,
} from "./mentions";

const search = defineRpc({
  name: "resources.search",
  input: z.object({ query: z.string() }),
  output: z.object({ items: z.array(z.unknown()) }),
});

const source: PluginAttachmentSourceContribution = {
  id: "history",
  title: "Session history",
  icon: "MessagesSquare",
  pickerTitle: "Reference a session",
  searchPlaceholder: "Search sessions",
  mentionPrefix: "sessions",
  search,
};

describe("plugin attachment mentions", () => {
  it("offers opted-in sources only from the composer host, with stable collision precedence", () => {
    const plugins = [
      { id: "history", serverId: "local", attachmentSources: [source] },
      { id: "remote", serverId: "other", attachmentSources: [source] },
      { id: "collision", serverId: "local", attachmentSources: [source] },
      {
        id: "picker-only",
        serverId: "local",
        attachmentSources: [{ ...source, mentionPrefix: undefined }],
      },
    ];

    expect(collectAttachmentMentionSources({ plugins, serverId: "local" })).toEqual([
      { key: "history/history", pluginId: "history", source, prefix: "sessions" },
    ]);
    expect(collectAttachmentMentionSources({ plugins, serverId: "other" })).toEqual([
      { key: "remote/history", pluginId: "remote", source, prefix: "sessions" },
    ]);
  });

  it("routes only an explicit source prefix, leaving files and unselected sources local", () => {
    const sources = collectAttachmentMentionSources({
      plugins: [{ id: "history", serverId: "local", attachmentSources: [source] }],
      serverId: "local",
    });
    const mention = { start: 8, end: 29, query: "sessions:lighting" };

    expect(resolveAttachmentMention({ mention, sources })).toEqual({
      source: sources[0],
      query: "lighting",
      mention,
    });
    expect(
      resolveAttachmentMention({ mention: { ...mention, query: "src/index.ts" }, sources }),
    ).toBeNull();
    expect(
      resolveAttachmentMention({ mention: { ...mention, query: "sessions" }, sources }),
    ).toBeNull();
    expect(
      resolveAttachmentMention({ mention: { ...mention, query: "other:lighting" }, sources }),
    ).toBeNull();
    expect(resolveAttachmentMention({ mention, sources: [] })).toBeNull();
    expect(resolveAttachmentMention({ mention: null, sources })).toBeNull();
  });

  it("replaces only the active mention and leaves the caret before the remaining instruction", () => {
    const text = "Compare @ses with the current plan";
    const mention = { start: 8, end: 12, query: "ses" };
    expect(replaceAttachmentMention({ text, mention, replacement: "@sessions:" })).toEqual({
      text: "Compare @sessions: with the current plan",
      selection: { start: 18, end: 18 },
    });
    expect(replaceAttachmentMention({ text, mention, replacement: "" })).toEqual({
      text: "Compare  with the current plan",
      selection: { start: 8, end: 8 },
    });
  });

  it("rejects a result selected after its query changed or its source disappeared", () => {
    const sources = collectAttachmentMentionSources({
      plugins: [{ id: "history", serverId: "local", attachmentSources: [source] }],
      serverId: "local",
    });
    const mention = { start: 0, end: 16, query: "sessions:budget" };
    const options = attachmentMentionOptions({
      sources,
      mention,
      items: [
        {
          id: "session-1",
          identifier: "SESSION-1",
          title: "Budget planning",
          url: "https://example.com/sessions/1",
          text: "Bounded context",
          resourceType: "session",
        },
      ],
    });
    const selection = { option: options[0]!, text: "@sessions:budget", mention, scoped: true };
    const accepted = selectAttachmentMention(selection);
    expect(accepted).toEqual({
      text: "",
      selection: { start: 0, end: 0 },
      attachment: {
        kind: "plugin_resource",
        pluginId: "history",
        sourceId: "history",
        sourceTitle: "Session history",
        sourceIcon: "MessagesSquare",
        item: {
          id: "session-1",
          identifier: "SESSION-1",
          title: "Budget planning",
          url: "https://example.com/sessions/1",
          text: "Bounded context",
          resourceType: "session",
        },
      },
    });
    expect(
      selectAttachmentMention({ ...selection, mention: { ...mention, query: "sessions:new" } }),
    ).toBeNull();
    expect(selectAttachmentMention({ ...selection, scoped: false })).toBeNull();
  });
});
