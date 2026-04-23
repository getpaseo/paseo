import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { StdioStreamTransport } from "./stdio-stream-transport.js";

function makeStreams() {
  const stdoutSrc = new PassThrough();
  const stdinSink = new PassThrough();
  return { stdoutSrc, stdinSink };
}

function collectStdin(stdin: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    stdin.on("data", (chunk) => {
      out += chunk.toString();
    });
    stdin.on("end", () => resolve(out));
  });
}

describe("StdioStreamTransport.send", () => {
  it("writes newline-delimited JSON to stdin", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    await transport.start();
    const outP = collectStdin(stdinSink);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" } as JSONRPCMessage);
    await transport.send({ jsonrpc: "2.0", id: 2, method: "pong" } as JSONRPCMessage);
    stdinSink.end();
    const out = await outP;
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: 1, method: "ping" });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ id: 2, method: "pong" });
  });

  it("rejects send after close", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    await transport.start();
    await transport.close();
    await expect(
      transport.send({ jsonrpc: "2.0", id: 1, method: "ping" } as JSONRPCMessage),
    ).rejects.toThrow(/closed/i);
  });
});

describe("StdioStreamTransport.receive (onmessage)", () => {
  it("parses one message per line", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();
    stdoutSrc.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { foo: "bar" } })}\n`);
    stdoutSrc.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { baz: "qux" } })}\n`);
    expect(received).toHaveLength(2);
    expect((received[0] as { result?: unknown }).result).toEqual({ foo: "bar" });
  });

  it("handles chunks that split messages across writes", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();
    const full = `${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`;
    stdoutSrc.write(full.slice(0, 10));
    stdoutSrc.write(full.slice(10));
    expect(received).toHaveLength(1);
    expect((received[0] as { id?: number }).id).toBe(7);
  });

  it("emits onerror on malformed JSON without crashing subsequent messages", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    transport.onmessage = (msg) => received.push(msg);
    transport.onerror = (err) => errors.push(err);
    await transport.start();
    stdoutSrc.write("not json at all\n");
    stdoutSrc.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })}\n`);
    expect(errors).toHaveLength(1);
    expect(received).toHaveLength(1);
  });

  it("strips trailing \\r in CRLF-framed output", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();
    stdoutSrc.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })}\r\n`);
    expect(received).toHaveLength(1);
  });

  it("ignores empty lines between messages", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();
    stdoutSrc.write(`\n\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })}\n\n`);
    expect(received).toHaveLength(1);
  });
});

describe("StdioStreamTransport lifecycle", () => {
  it("calls onclose when stdout closes", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();
    stdoutSrc.emit("close");
    expect(closed).toBe(true);
  });

  it("start twice throws", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    await transport.start();
    await expect(transport.start()).rejects.toThrow(/already started/i);
  });

  it("close detaches listeners (double close is idempotent)", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };
    await transport.start();
    await transport.close();
    await transport.close();
    expect(closeCount).toBe(1);
  });

  it("propagates stdout errors via onerror", async () => {
    const { stdoutSrc, stdinSink } = makeStreams();
    const transport = new StdioStreamTransport(stdoutSrc, stdinSink);
    const errors: Error[] = [];
    transport.onerror = (err) => errors.push(err);
    await transport.start();
    stdoutSrc.emit("error", new Error("boom"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("boom");
  });
});
