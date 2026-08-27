import { describe, expect, it } from "vitest";
import {
  createPluginResourceAttachment,
  PluginResourceComposerAttachmentSchema,
  pluginResourceAttachmentToAgentAttachment,
  togglePluginResourceAttachment,
} from "./model";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";

const source = {
  pluginId: "linear",
  sourceId: "issues",
  sourceTitle: "Linear issue",
  sourceIcon: "CircleDot",
};

const item = {
  id: "issue-uuid",
  identifier: "ENG-123",
  title: "Plugin attachments",
  subtitle: "In progress · Mohamed",
  url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
  text: "Linear issue ENG-123: Plugin attachments\nStatus: In progress",
  resourceType: "issue",
};

describe("plugin resource attachments", () => {
  it("creates a draft-safe composer attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(PluginResourceComposerAttachmentSchema.parse(attachment)).toEqual({
      kind: "plugin_resource",
      ...source,
      item,
    });
  });

  it("toggles one resource by plugin, source, and stable item id", () => {
    const attachment = createPluginResourceAttachment(source, item);

    expect(togglePluginResourceAttachment([], attachment)).toEqual([attachment]);
    expect(togglePluginResourceAttachment([attachment], attachment)).toEqual([]);
  });

  it("submits through the backward-compatible text attachment", () => {
    const attachment = createPluginResourceAttachment(source, item);

    const agentAttachment = pluginResourceAttachmentToAgentAttachment(attachment);
    expect(agentAttachment).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "ENG-123 Plugin attachments",
      text: item.text,
      externalResource: {
        provider: "linear",
        providerLabel: "Linear issue",
        resourceType: "issue",
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        url: item.url,
      },
    });
    expect(splitComposerAttachmentsForSubmit([attachment])).toEqual({
      images: [],
      attachments: [agentAttachment],
    });
  });
});
