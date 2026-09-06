import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

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

  it("uses the configured RPC timeout while waiting for a cold OMP", async () => {
    vi.useFakeTimers();
    const harness = transportHarness();
    const negotiation = establishOmpProtocol(harness.transport, pino({ level: "silent" }), {
      readyTimeoutMs: 60_000,
      requestTimeoutMs: 60_000,
    });
    const outcome = negotiation.then(
      () => "resolved",
      () => "rejected",
    );

    await vi.advanceTimersByTimeAsync(12_000);
    harness.emitReady(V2_READY);

    await expect(outcome).resolves.toBe("resolved");
  });

  it("waits 20 seconds for OMP to become ready", async () => {
    vi.useFakeTimers();
    const harness = transportHarness();
    const negotiation = establishOmpProtocol(harness.transport, pino({ level: "silent" }));
    const outcome = negotiation.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : "rejected with a non-Error value",
    );

    await vi.advanceTimersByTimeAsync(19_999);
    expect(harness.exitSubscribed()).toBe(true);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("Timed out waiting for OMP to become ready");
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
