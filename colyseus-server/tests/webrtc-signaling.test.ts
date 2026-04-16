import { describe, it, expect, vi } from "vitest";

/**
 * Tests for WebRTC signaling relay logic.
 * The actual relay happens inside SharedSessionRoom.handleWebRTCSignal,
 * which finds the target client and forwards the signal.
 * We test the logic in isolation.
 */

interface MockClient {
  auth: { userId: string };
  sent: Array<{ type: string; data: any }>;
  send(type: string, data: any): void;
}

function createMockClient(userId: string): MockClient {
  const client: MockClient = {
    auth: { userId },
    sent: [],
    send(type, data) {
      client.sent.push({ type, data });
    },
  };
  return client;
}

describe("WebRTC signaling relay", () => {
  function relaySignal(
    clients: MockClient[],
    senderUserId: string,
    signal: { targetUserId: string; kind: string; data: any },
  ) {
    // Simulates SharedSessionRoom.handleWebRTCSignal logic
    for (const c of clients) {
      if (c.auth.userId === signal.targetUserId) {
        c.send("webrtc_signal", {
          fromUserId: senderUserId,
          kind: signal.kind,
          data: signal.data,
        });
        return;
      }
    }
  }

  it("relays offer from sender to target", () => {
    const alice = createMockClient("alice");
    const bob = createMockClient("bob");

    relaySignal([alice, bob], "alice", {
      targetUserId: "bob",
      kind: "offer",
      data: { type: "offer", sdp: "v=0..." },
    });

    expect(bob.sent).toHaveLength(1);
    expect(bob.sent[0].type).toBe("webrtc_signal");
    expect(bob.sent[0].data.fromUserId).toBe("alice");
    expect(bob.sent[0].data.kind).toBe("offer");
    expect(bob.sent[0].data.data.type).toBe("offer");
  });

  it("relays answer back from target to sender", () => {
    const alice = createMockClient("alice");
    const bob = createMockClient("bob");

    relaySignal([alice, bob], "bob", {
      targetUserId: "alice",
      kind: "answer",
      data: { type: "answer", sdp: "v=0..." },
    });

    expect(alice.sent).toHaveLength(1);
    expect(alice.sent[0].data.fromUserId).toBe("bob");
    expect(alice.sent[0].data.kind).toBe("answer");
  });

  it("relays ICE candidates", () => {
    const alice = createMockClient("alice");
    const bob = createMockClient("bob");

    relaySignal([alice, bob], "alice", {
      targetUserId: "bob",
      kind: "ice-candidate",
      data: { candidate: "candidate:...", sdpMid: "0" },
    });

    expect(bob.sent).toHaveLength(1);
    expect(bob.sent[0].data.kind).toBe("ice-candidate");
  });

  it("does nothing if target client not found", () => {
    const alice = createMockClient("alice");

    relaySignal([alice], "alice", {
      targetUserId: "unknown",
      kind: "offer",
      data: {},
    });

    // No client should receive anything
    expect(alice.sent).toHaveLength(0);
  });

  it("handles mesh topology (3 participants)", () => {
    const alice = createMockClient("alice");
    const bob = createMockClient("bob");
    const charlie = createMockClient("charlie");
    const all = [alice, bob, charlie];

    // Alice sends offer to Bob
    relaySignal(all, "alice", { targetUserId: "bob", kind: "offer", data: {} });
    expect(bob.sent).toHaveLength(1);

    // Alice sends offer to Charlie
    relaySignal(all, "alice", { targetUserId: "charlie", kind: "offer", data: {} });
    expect(charlie.sent).toHaveLength(1);

    // Bob answers Alice
    relaySignal(all, "bob", { targetUserId: "alice", kind: "answer", data: {} });
    expect(alice.sent).toHaveLength(1);

    // Charlie answers Alice
    relaySignal(all, "charlie", { targetUserId: "alice", kind: "answer", data: {} });
    expect(alice.sent).toHaveLength(2);

    // Bob sends offer to Charlie (mesh)
    relaySignal(all, "bob", { targetUserId: "charlie", kind: "offer", data: {} });
    expect(charlie.sent).toHaveLength(2);
  });

  it("does not leak signals to non-target clients", () => {
    const alice = createMockClient("alice");
    const bob = createMockClient("bob");
    const charlie = createMockClient("charlie");
    const all = [alice, bob, charlie];

    relaySignal(all, "alice", { targetUserId: "bob", kind: "offer", data: {} });

    expect(bob.sent).toHaveLength(1);
    expect(alice.sent).toHaveLength(0);
    expect(charlie.sent).toHaveLength(0);
  });
});
