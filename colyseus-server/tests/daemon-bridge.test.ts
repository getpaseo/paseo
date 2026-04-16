import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaemonBridge } from "../src/services/daemon-bridge.js";

// Mock WebSocket
class MockWebSocket {
  handlers = new Map<string, Set<Function>>();
  sent: string[] = [];
  readyState = 1; // OPEN

  on(event: string, handler: Function) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: Function) {
    this.handlers.get(event)?.delete(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
  }

  emit(event: string, data?: any) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }
}

// Patch WebSocket constructor
vi.mock("ws", () => ({
  default: vi.fn().mockImplementation(() => new MockWebSocket()),
}));

describe("DaemonBridge", () => {
  let bridge: DaemonBridge;

  beforeEach(() => {
    bridge = new DaemonBridge("ws://localhost:6767", "session-1");
  });

  afterEach(() => {
    bridge.disconnect();
  });

  it("creates with correct initial state", () => {
    expect(bridge.isConnected()).toBe(false);
  });

  it("sends hello message on connect", () => {
    bridge.connect();
    const ws = (bridge as any).ws as MockWebSocket;

    // Simulate open
    ws.emit("open");

    expect(ws.sent.length).toBe(1);
    const hello = JSON.parse(ws.sent[0]);
    expect(hello.type).toBe("hello");
    expect(hello.clientId).toContain("colyseus-bridge-session-1");
  });

  it("tracks connection state", () => {
    bridge.connect();
    const ws = (bridge as any).ws as MockWebSocket;

    expect(bridge.isConnected()).toBe(false);
    ws.emit("open");
    expect(bridge.isConnected()).toBe(true);
  });

  it("calls status callback on agent events", () => {
    const callback = vi.fn();
    bridge.onAgentStatus(callback);
    bridge.connect();
    const ws = (bridge as any).ws as MockWebSocket;
    ws.emit("open");

    // Simulate agent_thinking event
    ws.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: { type: "agent_thinking" },
      }),
    );
    expect(callback).toHaveBeenCalledWith("running");

    // Simulate stream_finished
    ws.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: { type: "stream_finished" },
      }),
    );
    expect(callback).toHaveBeenCalledWith("idle");

    // Simulate attention_required
    ws.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: { type: "attention_required" },
      }),
    );
    expect(callback).toHaveBeenCalledWith("waiting_input");
  });

  it("disconnects cleanly", () => {
    bridge.connect();
    const ws = (bridge as any).ws as MockWebSocket;
    ws.emit("open");

    bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
    expect((bridge as any).ws).toBeNull();
  });

  it("ignores malformed messages", () => {
    const callback = vi.fn();
    bridge.onAgentStatus(callback);
    bridge.connect();
    const ws = (bridge as any).ws as MockWebSocket;
    ws.emit("open");

    // Non-JSON
    ws.emit("message", "not json");
    expect(callback).not.toHaveBeenCalled();

    // Missing type
    ws.emit("message", JSON.stringify({ foo: "bar" }));
    expect(callback).not.toHaveBeenCalled();
  });
});
