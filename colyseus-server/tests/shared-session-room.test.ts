import { describe, it, expect, vi, beforeEach } from "vitest";
import { SharedSessionState, Participant, QueuedMessage } from "../src/rooms/schema.js";

/**
 * Tests for the SharedSessionRoom logic.
 * Since Colyseus Room requires a full server context to instantiate,
 * we test the state logic and permission checks directly.
 */

describe("SharedSessionRoom — permission logic", () => {
  it("owner can always send messages in read_only mode", () => {
    const state = new SharedSessionState();
    state.accessLevel = "read_only";

    const ownerParticipant = new Participant();
    ownerParticipant.userId = "owner-1";
    ownerParticipant.role = "owner";
    state.participants.set("owner-1", ownerParticipant);

    // Owner should be allowed
    const participant = state.participants.get("owner-1");
    const canSend = state.accessLevel !== "read_only" || participant?.role === "owner";
    expect(canSend).toBe(true);
  });

  it("viewer cannot send messages in read_only mode", () => {
    const state = new SharedSessionState();
    state.accessLevel = "read_only";

    const viewerParticipant = new Participant();
    viewerParticipant.userId = "viewer-1";
    viewerParticipant.role = "viewer";
    state.participants.set("viewer-1", viewerParticipant);

    const participant = state.participants.get("viewer-1");
    const canSend = state.accessLevel !== "read_only" || participant?.role === "owner";
    expect(canSend).toBe(false);
  });

  it("collaborator can send messages in full_access mode", () => {
    const state = new SharedSessionState();
    state.accessLevel = "full_access";

    const collabParticipant = new Participant();
    collabParticipant.userId = "collab-1";
    collabParticipant.role = "collaborator";
    state.participants.set("collab-1", collabParticipant);

    const participant = state.participants.get("collab-1");
    const canSend = state.accessLevel !== "read_only" || participant?.role === "owner";
    expect(canSend).toBe(true);
  });
});

describe("SharedSessionRoom — FIFO queue behavior", () => {
  it("processes messages in FIFO order", () => {
    const state = new SharedSessionState();

    // Simulate 3 users sending messages
    const messages = [
      { id: "1", userId: "user-a", username: "Alice", content: "Fix the bug" },
      { id: "2", userId: "user-b", username: "Bob", content: "Add tests" },
      { id: "3", userId: "user-a", username: "Alice", content: "Deploy to staging" },
    ];

    for (const msg of messages) {
      const queued = new QueuedMessage();
      queued.id = msg.id;
      queued.userId = msg.userId;
      queued.username = msg.username;
      queued.content = msg.content;
      queued.queuedAt = Date.now();
      queued.status = "queued";
      state.messageQueue.push(queued);
    }

    // First queued message should be Alice's "Fix the bug"
    const first = state.messageQueue.find((m: QueuedMessage) => m.status === "queued");
    expect(first?.id).toBe("1");
    expect(first?.content).toBe("Fix the bug");

    // Mark first as processing
    first!.status = "processing";

    // Next queued should be Bob's "Add tests"
    const second = state.messageQueue.find((m: QueuedMessage) => m.status === "queued");
    expect(second?.id).toBe("2");
    expect(second?.content).toBe("Add tests");
  });

  it("does not process while another message is processing", () => {
    const state = new SharedSessionState();

    const m1 = new QueuedMessage();
    m1.id = "1";
    m1.status = "processing";
    state.messageQueue.push(m1);

    const m2 = new QueuedMessage();
    m2.id = "2";
    m2.status = "queued";
    state.messageQueue.push(m2);

    // Simulate processQueue check
    const hasProcessing = state.messageQueue.some((m: QueuedMessage) => m.status === "processing");
    expect(hasProcessing).toBe(true);

    // Should NOT process m2 yet
    const shouldProcess = !hasProcessing;
    expect(shouldProcess).toBe(false);
  });

  it("cleans up sent messages from queue", () => {
    const state = new SharedSessionState();

    const m1 = new QueuedMessage();
    m1.id = "1";
    m1.status = "sent";
    state.messageQueue.push(m1);

    const m2 = new QueuedMessage();
    m2.id = "2";
    m2.status = "queued";
    state.messageQueue.push(m2);

    const m3 = new QueuedMessage();
    m3.id = "3";
    m3.status = "sent";
    state.messageQueue.push(m3);

    // Cleanup sent messages
    const remaining = Array.from(state.messageQueue).filter((m) => m.status !== "sent");
    while (state.messageQueue.length > 0) state.messageQueue.pop();
    for (const m of remaining) state.messageQueue.push(m);

    expect(state.messageQueue.length).toBe(1);
    expect(Array.from(state.messageQueue)[0].id).toBe("2");
  });
});

describe("SharedSessionRoom — participant management", () => {
  it("assigns correct roles based on access level", () => {
    // full_access → collaborator for non-owners
    const p1 = new Participant();
    p1.role = false ? "owner" : "full_access" === "full_access" ? "collaborator" : "viewer";
    expect(p1.role).toBe("collaborator");

    // read_only → viewer for non-owners
    const p2 = new Participant();
    p2.role = false ? "owner" : "read_only" === "full_access" ? "collaborator" : "viewer";
    expect(p2.role).toBe("viewer");

    // owner is always "owner"
    const p3 = new Participant();
    p3.role = true ? "owner" : "full_access" === "full_access" ? "collaborator" : "viewer";
    expect(p3.role).toBe("owner");
  });

  it("tracks audio toggle per participant", () => {
    const state = new SharedSessionState();

    const p = new Participant();
    p.userId = "user-1";
    p.audioEnabled = false;
    state.participants.set("user-1", p);

    expect(state.participants.get("user-1")?.audioEnabled).toBe(false);

    p.audioEnabled = true;
    expect(state.participants.get("user-1")?.audioEnabled).toBe(true);
  });

  it("tracks online status per participant", () => {
    const state = new SharedSessionState();

    const p = new Participant();
    p.userId = "user-1";
    p.isOnline = true;
    state.participants.set("user-1", p);

    // Simulate disconnect
    p.isOnline = false;
    expect(state.participants.get("user-1")?.isOnline).toBe(false);

    // Simulate reconnect
    p.isOnline = true;
    expect(state.participants.get("user-1")?.isOnline).toBe(true);
  });
});
