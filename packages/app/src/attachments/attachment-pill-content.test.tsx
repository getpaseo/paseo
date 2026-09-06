import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  getAgentAttachmentPillContent,
  getAgentContextAttachmentPillContent,
} from "./attachment-pill-content";

describe("agent attachment pill content", () => {
  it("presents external resources with their provider identity", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "ENG-123 Plugin attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        externalResource: {
          provider: "linear",
          providerLabel: "Linear issue",
          resourceType: "issue",
          id: "issue-uuid",
          identifier: "ENG-123",
          title: "Plugin attachments",
          url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("Plugin attachments");
    expect(content.subtitle).toBe("Linear issue ENG-123");
  });

  it("labels a sent agent reference even when the optional wire title is absent", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "agent_context",
        agentId: "agent-source",
      },
      i18n.t,
    );

    expect(content.title).toBe("Agent context");
    expect(content.subtitle).toBe("Agent context");
  });

  it("uses persisted source presentation metadata in the composer pill", () => {
    const content = getAgentContextAttachmentPillContent(
      {
        kind: "agent_context",
        source: {
          serverId: "server-a",
          agentId: "agent-source",
          title: "Investigate auth race",
          workspaceLabel: "Paseo",
          provider: "codex",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("Investigate auth race");
    expect(content.subtitle).toBe("Paseo");
  });
});
