import pino from "pino";
import { describe, expect, it } from "vitest";
import type { JsonlRpcExit } from "../jsonl-rpc-process.js";
import { establishOmpProtocol, type OmpProtocolTransport } from "./protocol-session.js";

function transportHarness() {
  let receiveMessage: ((message: Record<string, unknown>) => void) | null = null;
  let receiveExit: ((exit: JsonlRpcExit) => void) | null = null;
  const requests: Array<{ command: Record<string, unknown>; timeoutMs: number | null }> = [];
  let response: unknown = { protocolVersion: 2 };
  const transport: OmpProtocolTransport = {
    onMessage(receiver) {
      receiveMessage = receiver;
      return () => {
        receiveMessage = null;
      };
    },
    onExit(receiver) {
      receiveExit = receiver;
      return () => {
        receiveExit = null;
      };
    },
    async request(command, timeoutMs) {
      requests.push({ command, timeoutMs });
      return response;
    },
  };
  return {
    transport,
    requests,
    emitReady: (frame: Record<string, unknown>) => receiveMessage?.(frame),
    setResponse: (value: unknown) => {
      response = value;
    },
    exitSubscribed: () => receiveExit !== null,
  };
}

const V2_READY = {
  type: "ready",
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

describe("establishOmpProtocol", () => {
  it("owns readiness and v2 negotiation", async () => {
    const harness = transportHarness();
    const negotiation = establishOmpProtocol(harness.transport, pino({ level: "silent" }));
    harness.emitReady(V2_READY);
    await negotiation;
    expect(harness.requests).toEqual([
      {
        command: { type: "negotiate_protocol", protocolVersion: 2 },
        timeoutMs: 30_000,
      },
    ]);
    expect(harness.exitSubscribed()).toBe(false);
  });

  it("keeps protocol v1 when the ready frame has no matching capability", async () => {
    const harness = transportHarness();
    const negotiation = establishOmpProtocol(harness.transport, pino({ level: "silent" }));
    harness.emitReady({ type: "ready" });
    await negotiation;
    expect(harness.requests).toEqual([]);
  });

  it("rejects a peer that does not confirm v2", async () => {
    const harness = transportHarness();
    harness.setResponse({ protocolVersion: 1 });
    const negotiation = establishOmpProtocol(harness.transport, pino({ level: "silent" }));
    harness.emitReady(V2_READY);
    await expect(negotiation).rejects.toThrow("OMP did not accept RPC protocol v2");
  });
});
