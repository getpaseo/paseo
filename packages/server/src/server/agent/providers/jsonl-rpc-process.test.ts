import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { JsonlRpcProcess, type JsonlRpcExit } from "./jsonl-rpc-process.js";

const CHILD_SOURCE = String.raw`
const readline = require("node:readline");

function respond(command, success, data, error) {
  process.stdout.write(JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success,
    data,
    error,
  }) + "\n");
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "echo") {
    setTimeout(() => respond(command, true, {
      value: command.value,
      cwd: process.cwd(),
      env: process.env.JSONL_RPC_TEST_VALUE,
      args: process.argv.slice(1),
    }), command.delayMs || 0);
    return;
  }
  if (command.type === "emit") {
    process.stdout.write("not json\n");
    process.stdout.write('{"type":"notice","text":"a');
    setTimeout(() => {
      process.stdout.write('\\u2028b"}\r\n');
      respond(command, true, null);
    }, 5);
    return;
  }
  if (command.type === "fail") {
    respond(command, false, null, "child rejected the request");
    return;
  }
  if (command.type === "hang") {
    return;
  }
  if (command.type === "exit") {
    process.stderr.write("child exploded");
    setTimeout(() => process.exit(7), 5);
  }
});
`;

interface InMemoryChildProcess extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

interface StartProcessOptions {
  child?: ChildProcessWithoutNullStreams;
}

function createInMemoryChildProcess(): InMemoryChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as InMemoryChildProcess;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

function startProcess(options: StartProcessOptions = {}): JsonlRpcProcess {
  const child = options.child;
  return new JsonlRpcProcess({
    launch: {
      command: process.execPath,
      args: ["-e", CHILD_SOURCE, "--", "resolved-arg"],
      cwd: process.cwd(),
      env: { JSONL_RPC_TEST_VALUE: "resolved-env" },
    },
    logger: pino({ level: "silent" }),
    ...(child ? { spawn: () => child } : {}),
  });
}

function nextExit(transport: JsonlRpcProcess): Promise<JsonlRpcExit> {
  return new Promise((resolve) => {
    const unsubscribe = transport.onExit((exit) => {
      unsubscribe();
      resolve(exit);
    });
  });
}

describe("JsonlRpcProcess", () => {
  test("spawns a resolved command and correlates concurrent requests", async () => {
    const transport = startProcess();

    try {
      const slow = transport.request({ type: "echo", value: "first", delayMs: 20 });
      const fast = transport.request({ type: "echo", value: "second" });

      await expect(Promise.all([slow, fast])).resolves.toEqual([
        {
          value: "first",
          cwd: process.cwd(),
          env: "resolved-env",
          args: ["resolved-arg"],
        },
        {
          value: "second",
          cwd: process.cwd(),
          env: "resolved-env",
          args: ["resolved-arg"],
        },
      ]);
    } finally {
      await transport.close();
    }
  });

  test("publishes complete LF-delimited JSON messages", async () => {
    const transport = startProcess();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    try {
      await transport.request({ type: "emit" });

      expect(messages).toEqual([{ type: "notice", text: "a\u2028b" }]);
    } finally {
      await transport.close();
    }
  });

  test("rejects unsuccessful responses", async () => {
    const transport = startProcess();

    try {
      await expect(transport.request({ type: "fail" })).rejects.toThrow(
        "child rejected the request",
      );
    } finally {
      await transport.close();
    }
  });

  test("includes buffered stderr when a request times out", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });

    try {
      child.stderr.write("still waiting");

      await expect(transport.request({ type: "hang" }, 50)).rejects.toThrow(
        "JSONL RPC request timed out for hang\nstill waiting",
      );
    } finally {
      await transport.close();
    }
  });

  test("null timeout waits past short wall-clock limits until the response arrives", async () => {
    const transport = startProcess();

    try {
      await expect(
        transport.request({ type: "echo", value: "slow", delayMs: 80 }, null),
      ).resolves.toMatchObject({ value: "slow" });
    } finally {
      await transport.close();
    }
  });

  test("null timeout still rejects when the process is closed", async () => {
    const transport = startProcess();
    await transport.request({ type: "echo", value: "ready" });
    const request = transport.request({ type: "hang" }, null);

    const rejection = expect(request).rejects.toThrow("JSONL RPC process is closed");
    await transport.close();

    await rejection;
  });

  test("rejects pending requests and publishes stderr when the child exits", async () => {
    const transport = startProcess();
    const exit = nextExit(transport);

    const request = transport.request({ type: "exit" });

    await expect(request).rejects.toThrow("child exploded");
    await expect(exit).resolves.toMatchObject({
      code: 7,
      signal: null,
      error: expect.objectContaining({
        message: expect.stringContaining("child exploded"),
      }),
    });
  });

  test("rejects pending requests while shutting down the child process", async () => {
    const transport = startProcess();
    await transport.request({ type: "echo", value: "ready" });
    const request = transport.request({ type: "hang" });

    const rejection = expect(request).rejects.toThrow("JSONL RPC process is closed");
    await transport.close();

    await rejection;
  });
});

describe("JsonlRpcProcess OMP v2 transport", () => {
  const readyFrame = {
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1024 * 1024,
    maxReassembledFrameBytes: 64 * 1024 * 1024,
  };

  function startInMemory(): { child: InMemoryChildProcess; transport: JsonlRpcProcess } {
    const child = createInMemoryChildProcess();
    return { child, transport: startProcess({ child }) };
  }

  function chunkedLines(frame: Record<string, unknown>, chunkId = "rpc-1"): string[] {
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    const byteLength = bytes.byteLength;
    const chunkSize = 256 * 1024;
    const count = Math.ceil(byteLength / chunkSize);
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      lines.push(
        JSON.stringify({
          type: "rpc_chunk",
          chunkId,
          index,
          count,
          byteLength,
          data: slice.toString("base64"),
        }),
      );
    }
    return lines;
  }

  test("awaitReady resolves with the retained raw ready frame and still delivers it to subscribers", async () => {
    const { child, transport } = startInMemory();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    const ready = transport.awaitReady();
    child.stdout.write(`${JSON.stringify(readyFrame)}\n`);

    await expect(ready).resolves.toEqual(readyFrame);
    expect(messages).toEqual([readyFrame]);
    await expect(transport.awaitReady()).resolves.toEqual(readyFrame);
    await transport.close();
  });

  test("awaitReady rejects when the process fails before the ready frame", async () => {
    const { child, transport } = startInMemory();
    const ready = transport.awaitReady();

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024 * 1024, data: "YQ==" })}\n`,
    );

    await expect(ready).rejects.toThrow("before the chunk decoder was enabled");
    await transport.close();
  });

  test("a chunk received before enableChunkDecoder is a fatal transport failure", async () => {
    const { child, transport } = startInMemory();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));
    const request = transport.request({ type: "hang" });
    const exit = nextExit(transport);

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024 * 1024, data: "YQ==" })}\n`,
    );

    await expect(request).rejects.toThrow("before the chunk decoder was enabled");
    await expect(exit).resolves.toMatchObject({ signal: "SIGTERM" });
    child.stdout.write(`${JSON.stringify({ type: "notice", text: "after" })}\n`);
    expect(messages).toEqual([]);
    await transport.close();
  });

  test("passes ordinary responses and events after enabling the chunk decoder", async () => {
    const { child, transport } = startInMemory();
    const events: Record<string, unknown>[] = [];
    transport.onMessage((message) => events.push(message));
    transport.enableChunkDecoder();
    const { id, promise } = transport.startRequest({ type: "echo" });

    child.stdout.write(`${JSON.stringify({ type: "notice", text: "before response" })}\n`);
    child.stdout.write(
      `${JSON.stringify({ id, type: "response", command: "echo", success: true, data: { value: "ok" } })}\n`,
    );

    await expect(promise).resolves.toEqual({ value: "ok" });
    expect(events).toEqual([{ type: "notice", text: "before response" }]);
    await transport.close();
  });

  test("reconstructs a >1 MiB chunked response and correlates it to the pending request", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const { id, promise } = transport.startRequest({ type: "echo" });
    const payload = "x".repeat(1024 * 1024);

    for (const line of chunkedLines({
      type: "response",
      id,
      command: "echo",
      success: true,
      data: { value: payload },
    })) {
      child.stdout.write(`${line}\n`);
    }

    const result = (await promise) as { value: string };
    expect(result.value).toBe(payload);
    await transport.close();
  });

  const malformedMetadataCases: { name: string; chunk: Record<string, unknown> }[] = [
    {
      name: "empty chunkId",
      chunk: { chunkId: "", index: 0, count: 2, byteLength: 1024 * 1024, data: "YQ==" },
    },
    {
      name: "count below 2",
      chunk: { chunkId: "rpc-1", index: 0, count: 1, byteLength: 1024 * 1024, data: "YQ==" },
    },
    {
      name: "index at or above count",
      chunk: { chunkId: "rpc-1", index: 2, count: 2, byteLength: 1024 * 1024, data: "YQ==" },
    },
    {
      name: "negative index",
      chunk: { chunkId: "rpc-1", index: -1, count: 2, byteLength: 1024 * 1024, data: "YQ==" },
    },
    {
      name: "non-integer index",
      chunk: { chunkId: "rpc-1", index: 0.5, count: 2, byteLength: 1024 * 1024, data: "YQ==" },
    },
    {
      name: "byteLength below 1 MiB",
      chunk: { chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024, data: "YQ==" },
    },
    {
      name: "count above 256",
      chunk: { chunkId: "rpc-1", index: 0, count: 257, byteLength: 64 * 1024 * 1024, data: "YQ==" },
    },
  ];

  test.each(malformedMetadataCases)(
    "rejects pending requests on malformed metadata: $name",
    async ({ chunk }) => {
      const { child, transport } = startInMemory();
      transport.enableChunkDecoder();
      const request = transport.request({ type: "hang" });

      child.stdout.write(`${JSON.stringify({ type: "rpc_chunk", ...chunk })}\n`);

      await expect(request).rejects.toThrow("invalid rpc chunk metadata");
      await transport.close();
    },
  );

  test.each([
    { name: "whitespace in data", data: "YQ ==" },
    { name: "non-canonical padding", data: "AB==" },
    { name: "empty data", data: "" },
  ])("rejects pending requests on non-canonical base64: $name", async ({ data }) => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024 * 1024, data })}\n`,
    );

    await expect(request).rejects.toThrow("invalid rpc chunk data");
    await transport.close();
  });

  test("rejects enabled transport on malformed JSON stdout", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write("{not-json}\n");

    await expect(request).rejects.toThrow("received invalid JSON stdout frame");
    await transport.close();
  });

  test("rejects a blank line that interrupts a chunk sequence", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024 * 1024, data: "YQ==" })}\n\n`,
    );

    await expect(request).rejects.toThrow("rpc chunk sequence interrupted");
    await transport.close();
  });

  test("rejects pending requests when chunks arrive out of order", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 1, count: 2, byteLength: 1024 * 1024, data: "YQ==" })}\n`,
    );

    await expect(request).rejects.toThrow("must start at index 0");
    await transport.close();
  });

  test("rejects pending requests when a non-chunk line interrupts a chunk sequence", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 1024 * 1024, data: "YQ==" })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ type: "notice", text: "interrupt" })}\n`);

    await expect(request).rejects.toThrow("rpc chunk sequence interrupted");
    await transport.close();
  });

  test("rejects pending requests when chunk bytes exceed the declared length", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });
    const byteLength = 1024 * 1024;
    const bytes = Buffer.alloc(byteLength + 1, 0x61);
    const chunkSize = 256 * 1024;
    const count = Math.ceil(bytes.byteLength / chunkSize);

    for (let index = 0; index < count; index += 1) {
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      child.stdout.write(
        `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index, count, byteLength, data: slice.toString("base64") })}\n`,
      );
    }

    await expect(request).rejects.toThrow("exceeds declared length");
    await transport.close();
  });

  test("rejects pending requests when a frame exceeds the 64 MiB reassembly cap", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });

    child.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index: 0, count: 2, byteLength: 64 * 1024 * 1024 + 1, data: "YQ==" })}\n`,
    );

    await expect(request).rejects.toThrow("invalid rpc chunk metadata");
    await transport.close();
  });

  test("rejects pending requests when a reassembled frame is not valid UTF-8", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });
    const byteLength = 1024 * 1024 + 1;
    const bytes = Buffer.alloc(byteLength, 0xff);
    const chunkSize = 256 * 1024;
    const count = Math.ceil(byteLength / chunkSize);

    for (let index = 0; index < count; index += 1) {
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      child.stdout.write(
        `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index, count, byteLength, data: slice.toString("base64") })}\n`,
      );
    }

    await expect(request).rejects.toBeInstanceOf(TypeError);
    await transport.close();
  });

  test("rejects pending requests when a reassembled frame is not an object", async () => {
    const { child, transport } = startInMemory();
    transport.enableChunkDecoder();
    const request = transport.request({ type: "hang" });
    const bytes = Buffer.from(JSON.stringify(["x".repeat(1024 * 1024)]), "utf8");
    const byteLength = bytes.byteLength;
    const chunkSize = 256 * 1024;
    const count = Math.ceil(byteLength / chunkSize);

    for (let index = 0; index < count; index += 1) {
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      child.stdout.write(
        `${JSON.stringify({ type: "rpc_chunk", chunkId: "rpc-1", index, count, byteLength, data: slice.toString("base64") })}\n`,
      );
    }

    await expect(request).rejects.toThrow("rpc frame must be an object");
    await transport.close();
  });

  test("eager ordinary operation works without any opt-in", async () => {
    const { child, transport } = startInMemory();
    const messages: Record<string, unknown>[] = [];
    transport.onMessage((message) => messages.push(message));

    child.stdout.write(`${JSON.stringify(readyFrame)}\n`);
    child.stdout.write(`${JSON.stringify({ type: "notice", text: "hello" })}\n`);
    const request = transport.request({ type: "echo", value: "eager" });
    child.stdout.write(
      `${JSON.stringify({ type: "response", id: "req_1", command: "echo", success: true, data: { value: "eager" } })}\n`,
    );

    await expect(request).resolves.toEqual({ value: "eager" });
    expect(messages).toEqual([readyFrame, { type: "notice", text: "hello" }]);
    await transport.close();
  });

  test("requestResponse resolves with the full correlated response envelope", async () => {
    const { child, transport } = startInMemory();
    const response = transport.requestResponse({ type: "negotiate_protocol", protocolVersion: 2 });

    child.stdout.write(
      `${JSON.stringify({ type: "response", id: "req_1", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } })}\n`,
    );

    await expect(response).resolves.toEqual({
      type: "response",
      id: "req_1",
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 },
    });
    await transport.close();
  });

  test("requestResponse rejects on unsuccessful responses", async () => {
    const { child, transport } = startInMemory();
    const response = transport.requestResponse({ type: "negotiate_protocol", protocolVersion: 2 });

    child.stdout.write(
      `${JSON.stringify({ type: "response", id: "req_1", command: "negotiate_protocol", success: false, error: "protocol rejected" })}\n`,
    );

    await expect(response).rejects.toThrow("protocol rejected");
    await transport.close();
  });
});
