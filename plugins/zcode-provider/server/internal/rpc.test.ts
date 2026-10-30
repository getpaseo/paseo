import { describe, expect, test, vi } from "vitest";
import { ZCodeRpcClient, isMethodNotFound } from "./rpc.js";

/**
 * The base client has no output stream; it throws when a call writes. The
 * process layer supplies one, so the test supplies one too.
 */
class TestRpcClient extends ZCodeRpcClient {
  readonly written: string[] = [];

  protected override write(line: string): void {
    this.written.push(line);
  }
}

describe("ZCode RPC client", () => {
  test("resolves a call when the matching response arrives", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("writes the encoded request with its own id", () => {
    const client = new TestRpcClient();
    void client.call("session/read", { sessionId: "s1" }).catch(() => undefined);
    expect(JSON.parse(client.written[0]!)).toEqual({
      id: "1",
      method: "session/read",
      params: { sessionId: "s1" },
    });
  });

  test("rejects a call when the protocol answers with an error", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", error: { code: -32601, message: "no method" } }));
    await expect(pending).rejects.toThrow("no method");
  });

  test("recognizes a method-not-found failure", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/steer", { sessionId: "s1" });
    client.receive(JSON.stringify({ id: "1", error: { code: -32601, message: "no method" } }));
    const error = await pending.catch((value: unknown) => value);
    expect(isMethodNotFound(error)).toBe(true);
  });

  test("dispatches events to listeners and survives a broken frame", () => {
    const client = new TestRpcClient();
    const seen: string[] = [];
    client.onEvent((event) => seen.push(event.type));
    client.receive("{broken");
    client.receive(
      JSON.stringify({
        eventId: "e1",
        sessionId: "s1",
        seq: 1,
        timestamp: 1,
        type: "turn.started",
      }),
    );
    expect(seen).toEqual(["turn.started"]);
  });

  test("rejects every pending call when the connection closes", async () => {
    const client = new TestRpcClient();
    const pending = client.call("session/read", { sessionId: "s1" });
    client.close();
    await expect(pending).rejects.toThrow(/closed/i);
  });

  test("answers a request ZCode sends to the host", async () => {
    const client = new TestRpcClient();
    client.onRequest((request) => {
      expect(request.method).toBe("interaction/requestPermission");
      return { decision: "allow" };
    });
    client.receive(
      JSON.stringify({
        id: "9",
        method: "interaction/requestPermission",
        params: { requestId: "p1" },
      }),
    );
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    expect(JSON.parse(client.written[0]!)).toEqual({
      id: "9",
      result: { decision: "allow" },
    });
  });

  test("answers a request with an error when the handler throws", async () => {
    const client = new TestRpcClient();
    client.onRequest(() => {
      throw new Error("denied");
    });
    client.receive(JSON.stringify({ id: "9", method: "interaction/requestPermission" }));
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    expect(JSON.parse(client.written[0]!)).toEqual({
      id: "9",
      error: { code: -32603, message: "denied" },
    });
  });

  test("answers a request with method-not-found when nothing handles it", async () => {
    const client = new TestRpcClient();
    client.receive(JSON.stringify({ id: "9", method: "interaction/requestPermission" }));
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    expect(JSON.parse(client.written[0]!)).toEqual({
      id: "9",
      error: { code: -32601, message: "Unknown method: interaction/requestPermission" },
    });
  });
});
