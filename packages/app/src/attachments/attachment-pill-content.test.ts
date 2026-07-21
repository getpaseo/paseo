import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Reflect.set(globalThis, "React", { createElement: () => null });
});

vi.mock("lucide-react-native", () => ({
  Bot: "Bot",
  CircleDot: "CircleDot",
  FileText: "FileText",
  GitPullRequest: "GitPullRequest",
  MessageSquareCode: "MessageSquareCode",
  MousePointer2: "MousePointer2",
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
}));

import { i18n } from "@/i18n/i18next";
import {
  getAgentAttachmentPillContent,
  getAgentContextAttachmentPillContent,
} from "./attachment-pill-content";

describe("agent context attachment pill content", () => {
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
