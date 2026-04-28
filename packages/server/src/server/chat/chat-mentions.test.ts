import { describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import {
  buildChatMentionNotification,
  notifyChatMentions,
  resolveChatMentionTargetAgentIds,
} from "./chat-mentions.js";

function storedAgent(overrides: Partial<StoredAgentRecord> & { id: string }): StoredAgentRecord {
  return { internal: false, archivedAt: null, ...overrides } as StoredAgentRecord;
}

function liveAgent(overrides: Partial<ManagedAgent> & { id: string }): ManagedAgent {
  return { internal: false, ...overrides } as ManagedAgent;
}

describe("chat mentions", () => {
  test("@everyone expands to active non-archived agents", () => {
    const targets = resolveChatMentionTargetAgentIds({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [
        storedAgent({ id: "agent-a" }),
        storedAgent({ id: "agent-b", archivedAt: "2026-03-28T00:00:00.000Z" }),
        storedAgent({ id: "author-agent" }),
        storedAgent({ id: "internal-agent", internal: true }),
      ],
      liveAgents: [
        liveAgent({ id: "agent-c" }),
        liveAgent({ id: "internal-live", internal: true }),
      ],
    });

    expect(targets.sort()).toEqual(["agent-a", "agent-c"]);
  });

  test("@everyone deduplicates with explicit mentions and keeps explicit non-everyone mentions", () => {
    const targets = resolveChatMentionTargetAgentIds({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone", "agent-a", "custom-title"],
      storedAgents: [storedAgent({ id: "agent-a" })],
      liveAgents: [liveAgent({ id: "agent-b" })],
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
    } as unknown as pino.Logger;

    await notifyChatMentions({
      room: "coord-room",
      authorAgentId: "author-agent",
      body: "@everyone Check status",
      mentionAgentIds: ["everyone"],
      logger,
      listStoredAgents: async () => [storedAgent({ id: "agent-a" })],
      listLiveAgents: () => [liveAgent({ id: "agent-b" })],
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
