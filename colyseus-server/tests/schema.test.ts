import { describe, it, expect } from "vitest";
import { SharedSessionState, Participant, QueuedMessage } from "../src/rooms/schema.js";
import { MapSchema, ArraySchema } from "@colyseus/schema";

describe("SharedSessionState", () => {
  it("initializes with default values", () => {
    const state = new SharedSessionState();
    expect(state.shareId).toBe("");
    expect(state.accessLevel).toBe("read_only");
    expect(state.agentStatus).toBe("idle");
    expect(state.participants).toBeInstanceOf(MapSchema);
    expect(state.messageQueue).toBeInstanceOf(ArraySchema);
    expect(state.participants.size).toBe(0);
    expect(state.messageQueue.length).toBe(0);
  });

  it("can set state properties", () => {
    const state = new SharedSessionState();
    state.shareId = "share-123";
    state.accessLevel = "full_access";
    state.agentStatus = "running";
    expect(state.shareId).toBe("share-123");
    expect(state.accessLevel).toBe("full_access");
    expect(state.agentStatus).toBe("running");
  });
});

describe("Participant", () => {
  it("initializes with defaults", () => {
    const p = new Participant();
    expect(p.userId).toBe("");
    expect(p.role).toBe("viewer");
    expect(p.audioEnabled).toBe(false);
    expect(p.isOnline).toBe(true);
    expect(p.joinedAt).toBe(0);
  });

  it("can be added to state participants map", () => {
    const state = new SharedSessionState();
    const p = new Participant();
    p.userId = "user-1";
    p.username = "Test User";
    p.role = "owner";
    p.joinedAt = Date.now();

    state.participants.set("user-1", p);
    expect(state.participants.size).toBe(1);
    expect(state.participants.get("user-1")?.username).toBe("Test User");
    expect(state.participants.get("user-1")?.role).toBe("owner");
  });

  it("can remove participant", () => {
    const state = new SharedSessionState();
    const p = new Participant();
    p.userId = "user-1";
    state.participants.set("user-1", p);
    expect(state.participants.size).toBe(1);

    state.participants.delete("user-1");
    expect(state.participants.size).toBe(0);
  });
});

describe("QueuedMessage", () => {
  it("initializes with defaults", () => {
    const m = new QueuedMessage();
    expect(m.id).toBe("");
    expect(m.status).toBe("queued");
  });

  it("maintains FIFO order in array", () => {
    const state = new SharedSessionState();

    const m1 = new QueuedMessage();
    m1.id = "msg-1";
    m1.content = "First message";
    m1.queuedAt = 1000;

    const m2 = new QueuedMessage();
    m2.id = "msg-2";
    m2.content = "Second message";
    m2.queuedAt = 2000;

    const m3 = new QueuedMessage();
    m3.id = "msg-3";
    m3.content = "Third message";
    m3.queuedAt = 3000;

    state.messageQueue.push(m1);
    state.messageQueue.push(m2);
    state.messageQueue.push(m3);

    expect(state.messageQueue.length).toBe(3);
    const items = Array.from(state.messageQueue);
    expect(items[0].id).toBe("msg-1");
    expect(items[1].id).toBe("msg-2");
    expect(items[2].id).toBe("msg-3");
  });

  it("can find first queued message (FIFO)", () => {
    const state = new SharedSessionState();

    const m1 = new QueuedMessage();
    m1.id = "msg-1";
    m1.status = "processing";

    const m2 = new QueuedMessage();
    m2.id = "msg-2";
    m2.status = "queued";

    const m3 = new QueuedMessage();
    m3.id = "msg-3";
    m3.status = "queued";

    state.messageQueue.push(m1);
    state.messageQueue.push(m2);
    state.messageQueue.push(m3);

    const next = state.messageQueue.find((m: QueuedMessage) => m.status === "queued");
    expect(next?.id).toBe("msg-2");
  });

  it("can remove sent messages", () => {
    const state = new SharedSessionState();

    const m1 = new QueuedMessage();
    m1.id = "msg-1";
    m1.status = "sent";

    const m2 = new QueuedMessage();
    m2.id = "msg-2";
    m2.status = "queued";

    state.messageQueue.push(m1);
    state.messageQueue.push(m2);

    // Remove sent messages (convert to array, filter, rebuild)
    const remaining = Array.from(state.messageQueue).filter(m => m.status !== "sent");
    while (state.messageQueue.length > 0) state.messageQueue.pop();
    for (const m of remaining) state.messageQueue.push(m);

    expect(state.messageQueue.length).toBe(1);
    expect(Array.from(state.messageQueue)[0].id).toBe("msg-2");
  });
});
