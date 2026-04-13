import { describe, expect, test, vi } from "vitest";
import {
  buildChatMentionNotification,
  notifyChatMentions,
  resolveChatMentionTargetAgentIds,
} from "./chat-mentions.js";

describe("chat mentions", () => {
  test("@everyone expands to active non-archived agents", () => {
    const targets = resolveChatMentionTargetAgentIds({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [
        { id: "agent-a", internal: false, archivedAt: null } as any,
        { id: "agent-b", internal: false, archivedAt: "2026-03-28T00:00:00.000Z" } as any,
        { id: "author-agent", internal: false, archivedAt: null } as any,
        { id: "internal-agent", internal: true, archivedAt: null } as any,
      ],
      liveAgents: [
        { id: "agent-c", internal: false } as any,
        { id: "internal-live", internal: true } as any,
      ],
    });

    expect(targets.sort()).toEqual(["agent-a", "agent-c"]);
  });

  test("@everyone deduplicates with explicit mentions and keeps explicit non-everyone mentions", () => {
    const targets = resolveChatMentionTargetAgentIds({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone", "agent-a", "custom-title"],
      storedAgents: [{ id: "agent-a", internal: false, archivedAt: null } as any],
      liveAgents: [{ id: "agent-b", internal: false } as any],
    });

    expect(targets.sort()).toEqual(["agent-a", "agent-b", "custom-title"]);
  });

  test("notification body strips inline mentions but keeps the room context", () => {
    expect(
      buildChatMentionNotification({
        room: "coord-room",
        authorAgentId: "author-agent",
        body: "@agent-a @everyone Check the latest status.",
        mentionAgentIds: ["agent-a", "everyone"],
      }),
    ).toContain("Check the latest status.");
  });

  test("notifyChatMentions delegates sends for resolved targets", async () => {
    const resolveAgentIdentifier = vi.fn(async (identifier: string) => ({
      ok: true as const,
      agentId: identifier,
    }));
    const sendAgentMessage = vi.fn(async () => {});
    const logger = {
      warn: vi.fn(),
    } as any;

    await notifyChatMentions({
      room: "coord-room",
      authorAgentId: "author-agent",
      body: "@everyone Check status",
      mentionAgentIds: ["everyone"],
      logger,
      listStoredAgents: async () => [{ id: "agent-a", internal: false, archivedAt: null } as any],
      listLiveAgents: () => [{ id: "agent-b", internal: false } as any],
      resolveAgentIdentifier,
      sendAgentMessage,
    });

    expect(resolveAgentIdentifier).toHaveBeenCalledTimes(2);
    expect(sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "agent-a",
      expect.stringContaining('room "coord-room"'),
    );
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "agent-b",
      expect.stringContaining("Check status"),
    );
  });
});
