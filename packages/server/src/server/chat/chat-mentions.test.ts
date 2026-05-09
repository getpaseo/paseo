import { describe, expect, test, vi } from "vitest";
import type pino from "pino";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import {
  buildChatMentionNotification,
  notifyChatMentions,
  prepareChatMentionFanout,
} from "./chat-mentions.js";

function storedAgent(overrides: Partial<StoredAgentRecord> & { id: string }): StoredAgentRecord {
  return {
    internal: false,
    archivedAt: null,
    lastStatus: "idle",
    ...overrides,
  } as StoredAgentRecord;
}

function liveAgent(overrides: Partial<ManagedAgent> & { id: string }): ManagedAgent {
  return { internal: false, lifecycle: "idle", ...overrides } as ManagedAgent;
}

async function prepare(input: {
  authorAgentId: string;
  mentionAgentIds: string[];
  storedAgents?: StoredAgentRecord[];
  liveAgents?: ManagedAgent[];
  roomPosterAgentIds?: string[];
  limit?: number;
}) {
  const result = await prepareChatMentionFanout({
    authorAgentId: input.authorAgentId,
    mentionAgentIds: input.mentionAgentIds,
    storedAgents: input.storedAgents ?? [],
    liveAgents: input.liveAgents ?? [],
    listRoomPosterAgentIds: async () => input.roomPosterAgentIds ?? [],
    limit: input.limit,
  });
  if (!result.ok) {
    throw new Error(`expected ok prepare, got error: ${result.error}`);
  }
  return result.prepared;
}

describe("chat mentions", () => {
  test("@everyone in an empty room resolves to no targets", async () => {
    const prepared = await prepare({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [storedAgent({ id: "unrelated-agent" })],
      liveAgents: [liveAgent({ id: "live-unrelated-agent" })],
      roomPosterAgentIds: [],
    });

    expect(prepared.targetMentionAgentIds).toEqual([]);
  });

  test("@everyone in a single-poster room excludes the author", async () => {
    const prepared = await prepare({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [storedAgent({ id: "author-agent" })],
      roomPosterAgentIds: ["author-agent"],
    });

    expect(prepared.targetMentionAgentIds).toEqual([]);
  });

  test("@everyone only expands to active posters in the room", async () => {
    const prepared = await prepare({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [
        storedAgent({ id: "agent-a" }),
        storedAgent({ id: "agent-b" }),
        storedAgent({ id: "unrelated-agent" }),
      ],
      liveAgents: [liveAgent({ id: "agent-c" }), liveAgent({ id: "live-unrelated-agent" })],
      roomPosterAgentIds: ["agent-a", "agent-b", "agent-c"],
    });

    expect([...prepared.targetMentionAgentIds].sort()).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  test("@everyone excludes archived and error-state agents", async () => {
    const prepared = await prepare({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: [
        storedAgent({ id: "active-agent" }),
        storedAgent({ id: "archived-agent", archivedAt: "2026-03-28T00:00:00.000Z" }),
        storedAgent({ id: "stored-error-agent", lastStatus: "error" }),
      ],
      liveAgents: [liveAgent({ id: "live-error-agent", lifecycle: "error" })],
      roomPosterAgentIds: [
        "active-agent",
        "archived-agent",
        "stored-error-agent",
        "live-error-agent",
      ],
    });

    expect(prepared.targetMentionAgentIds).toEqual(["active-agent"]);
  });

  test("@everyone deduplicates with explicit mentions and keeps explicit non-everyone mentions", async () => {
    const prepared = await prepare({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone", "agent-a", "custom-title"],
      storedAgents: [storedAgent({ id: "agent-a" })],
      liveAgents: [liveAgent({ id: "agent-b" })],
      roomPosterAgentIds: ["agent-a", "agent-b"],
    });

    expect([...prepared.targetMentionAgentIds].sort()).toEqual([
      "agent-a",
      "agent-b",
      "custom-title",
    ]);
  });

  test("does not list room posters when @everyone is not mentioned", async () => {
    const listRoomPosterAgentIds = vi.fn(async () => []);
    const result = await prepareChatMentionFanout({
      authorAgentId: "author-agent",
      mentionAgentIds: ["agent-a"],
      storedAgents: [storedAgent({ id: "agent-a" })],
      liveAgents: [],
      listRoomPosterAgentIds,
    });

    expect(result.ok).toBe(true);
    expect(listRoomPosterAgentIds).not.toHaveBeenCalled();
  });

  test("rejects @everyone fan-out above the hard cap", async () => {
    const posters = Array.from({ length: 26 }, (_, index) => `agent-${index}`);
    const result = await prepareChatMentionFanout({
      authorAgentId: "author-agent",
      mentionAgentIds: ["everyone"],
      storedAgents: posters.map((id) => storedAgent({ id })),
      liveAgents: [],
      listRoomPosterAgentIds: async () => posters,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "@everyone would notify 26 agents, which exceeds the limit of 25. Narrow the room or mention specific agents.",
    });
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

    const storedAgents = [storedAgent({ id: "agent-a" })];
    const liveAgents = [liveAgent({ id: "agent-b" })];

    await notifyChatMentions({
      room: "coord-room",
      authorAgentId: "author-agent",
      body: "@everyone Check status",
      mentionAgentIds: ["everyone"],
      logger,
      storedAgents,
      liveAgents,
      prepared: {
        targetMentionAgentIds: ["agent-a", "agent-b"],
        roomPosterAgentIds: ["agent-a", "agent-b"],
      },
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
