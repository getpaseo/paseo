import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import {
  type ChatServiceError,
  FileBackedChatService,
  parseMentionAgentIds,
  type PostChatMessageInput,
} from "./chat-service.js";

describe("FileBackedChatService", () => {
  let paseoHome: string;
  let service: FileBackedChatService;

  async function sendChatMessage(input: PostChatMessageInput) {
    return await service.dispatchMessage(input);
  }

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-chat-service-"));
    service = new FileBackedChatService({
      paseoHome,
      logger: pino({ level: "silent" }),
    });
    await service.initialize();
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates rooms, enforces unique names, and persists to disk", async () => {
    const created = await service.createRoom({
      name: "cli-features-epic",
      purpose: "Coordination room",
    });

    await expect(
      service.createRoom({
        name: "CLI-FEATURES-EPIC",
      }),
    ).rejects.toMatchObject<Partial<ChatServiceError>>({
      code: "chat_room_name_taken",
    });

    const raw = await readFile(path.join(paseoHome, "chat", "rooms.json"), "utf8");
    expect(raw).toContain("cli-features-epic");
    expect(created.name).toBe("cli-features-epic");
    expect(created.purpose).toBe("Coordination room");
    expect(created.messageCount).toBe(0);
  });

  test("resolves rooms by name or ID, validates replies, and reads filtered messages", async () => {
    const room = await service.createRoom({ name: "auth-refactor" });
    const first = await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "first message for @agent-b and @agent-c and again @agent-b",
    });
    await sendChatMessage({
      room: room.id,
      authorAgentId: "agent-b",
      body: "reply",
      replyToMessageId: first.id,
    });

    await expect(
      sendChatMessage({
        room: room.name,
        authorAgentId: "agent-b",
        body: "bad reply",
        replyToMessageId: "missing",
      }),
    ).rejects.toMatchObject<Partial<ChatServiceError>>({
      code: "chat_message_not_found",
    });

    const all = await service.readMessages({ room: room.name, limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]?.mentionAgentIds).toEqual(["agent-b", "agent-c"]);

    const byAuthor = await service.readMessages({
      room: room.id,
      authorAgentId: "agent-b",
      limit: 10,
    });
    expect(byAuthor).toHaveLength(1);
    expect(byAuthor[0]?.body).toBe("reply");

    const detail = await service.inspectRoom({ room: room.name });
    expect(detail.room.messageCount).toBe(2);
    expect(detail.room.lastMessageAt).toBeTruthy();
  });

  test("lists unique agents who have posted to a room", async () => {
    const room = await service.createRoom({ name: "incident-room" });
    const otherRoom = await service.createRoom({ name: "other-room" });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "first",
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-b",
      body: "second",
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "third",
    });
    await sendChatMessage({
      room: otherRoom.name,
      authorAgentId: "unrelated-agent",
      body: "different room",
    });

    await expect(service.listRoomPosterAgentIds({ room: room.name })).resolves.toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  test("waits for new messages after a cursor and times out with an empty result", async () => {
    const room = await service.createRoom({ name: "loop-status" });
    const first = await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "ready",
    });

    const waitPromise = service.waitForMessages({
      room: room.name,
      afterMessageId: first.id,
      timeoutMs: 1000,
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-b",
      body: "new work",
    });

    const waited = await waitPromise;
    expect(waited).toHaveLength(1);
    expect(waited[0]?.body).toBe("new work");

    const timedOut = await service.waitForMessages({
      room: room.name,
      afterMessageId: waited[0]?.id,
      timeoutMs: 10,
    });
    expect(timedOut).toEqual([]);
  });

  test("deletes rooms, removes messages, and rejects pending waiters", async () => {
    const room = await service.createRoom({ name: "schedule-jobs" });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "hello",
    });

    const waitPromise = service.waitForMessages({
      room: room.name,
      timeoutMs: 1000,
    });
    const deleted = await service.deleteRoom({ room: room.id });
    expect(deleted.room.messageCount).toBe(1);

    await expect(waitPromise).rejects.toMatchObject<Partial<ChatServiceError>>({
      code: "chat_room_deleted",
    });
    await expect(service.inspectRoom({ room: room.name })).rejects.toMatchObject<
      Partial<ChatServiceError>
    >({
      code: "chat_room_not_found",
    });
  });

  test("extracts inline mentions from chat bodies", () => {
    expect(
      parseMentionAgentIds(
        "Checking with @agent-a, (@agent_b), @everyone, and duplicate @agent-a again.",
      ),
    ).toEqual(["agent-a", "agent_b", "everyone"]);
    expect(parseMentionAgentIds("email@example.com is not a mention")).toEqual([]);
  });
});
