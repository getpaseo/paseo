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

const CLOSED_STDIN_CHILD_SOURCE = String.raw`
const fs = require("node:fs");

fs.closeSync(0);
process.stdout.write(JSON.stringify({ type: "stdin_closed" }) + "\n");
setInterval(() => {}, 1_000);
`;

interface InMemoryChildProcess extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

interface StartProcessOptions {
  child?: ChildProcessWithoutNullStreams;
  defaultRequestTimeoutMs?: number;
  source?: string;
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
      args: ["-e", options.source ?? CHILD_SOURCE, "--", "resolved-arg"],
      cwd: process.cwd(),
      env: { JSONL_RPC_TEST_VALUE: "resolved-env" },
    },
    logger: pino({ level: "silent" }),
    defaultRequestTimeoutMs: options.defaultRequestTimeoutMs,
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
    const transport = startProcess({ child, defaultRequestTimeoutMs: 50 });

    try {
      child.stderr.write("still waiting");

      await expect(transport.request({ type: "hang" })).rejects.toThrow(
        /JSONL RPC request timed out phase=hang elapsedMs=\d+ timeoutMs=50\nstill waiting/,
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

  test("closes the transport when a direct send synchronously throws EPIPE", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });

    child.stdin.write = () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };

    expect(() => transport.send({ type: "notice" })).not.toThrow();
    await expect(transport.request({ type: "echo", value: "after" })).rejects.toThrow(
      "JSONL RPC process is closed",
    );
  });

  // Closing fd 0 does not sever the inherited pipe on Windows, so this fixture cannot produce EPIPE.
  test.skipIf(process.platform === "win32")(
    "keeps the parent alive when a real child closes its stdin pipe",
    async () => {
      const transport = startProcess({ source: CLOSED_STDIN_CHILD_SOURCE });
      const stdinClosed = new Promise<void>((resolve) => {
        const unsubscribe = transport.onMessage((message) => {
          if (message.type !== "stdin_closed") return;
          unsubscribe();
          resolve();
        });
      });

      await stdinClosed;
      await expect(transport.request({ type: "echo", value: "after" })).rejects.toThrow(
        /EPIPE|stdin is not writable/,
      );
      await expect(transport.request({ type: "echo", value: "later" })).rejects.toThrow(
        "JSONL RPC process is closed",
      );
    },
  );

  test("stdin error events close the transport instead of becoming uncaught exceptions", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    const request = transport.request({ type: "hang" });
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    child.stdin.emit("error", err);

    await expect(request).rejects.toThrow("write EPIPE");
    await expect(transport.request({ type: "echo", value: "after" })).rejects.toThrow(
      "JSONL RPC process is closed",
    );
  });

  test("a non-writable stdin closes the transport instead of hanging the request", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });
    child.stdin.end();

    await expect(transport.request({ type: "hang" })).rejects.toThrow(
      "JSONL RPC stdin is not writable",
    );
    await expect(transport.request({ type: "echo", value: "after" })).rejects.toThrow(
      "JSONL RPC process is closed",
    );
  });

  test("reassembles protocol v2 chunked responses into the logical frame", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });

    try {
      let buffer = "";
      const sentRequest = new Promise<Record<string, unknown>>((resolve) => {
        child.stdin.on("data", (chunk) => {
          buffer += chunk.toString();
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) return;
          resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>);
        });
      });

      const request = transport.request({ type: "chunked" });
      const command = await sentRequest;

      // Emit a logical response split into protocol v2 chunk frames.
      const value = "x".repeat(1024 * 1024);
      const logical = JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { value },
      });
      const bytes = Buffer.from(logical, "utf8");
      expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
      const chunkPayload = 256 * 1024;
      const count = Math.ceil(bytes.length / chunkPayload);
      expect(count).toBeGreaterThan(1);
      for (let index = 0; index < count; index++) {
        child.stdout.write(
          `${JSON.stringify({
            type: "rpc_chunk",
            chunkId: "seq1",
            index,
            count,
            byteLength: bytes.length,
            data: bytes
              .subarray(index * chunkPayload, (index + 1) * chunkPayload)
              .toString("base64"),
          })}\n`,
        );
      }

      await expect(request).resolves.toEqual({ value });
    } finally {
      await transport.close();
    }
  });

  test("rejects protocol v2 chunks larger than the transport payload limit", async () => {
    const child = createInMemoryChildProcess();
    const transport = startProcess({ child });

    try {
      let buffer = "";
      const sentRequest = new Promise<Record<string, unknown>>((resolve) => {
        child.stdin.on("data", (chunk) => {
          buffer += chunk.toString();
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) return;
          resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>);
        });
      });

      const request = transport.request({ type: "oversized-chunks" });
      const command = await sentRequest;
      const logicalResponse = (value: string): Buffer =>
        Buffer.from(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: { value },
          }),
          "utf8",
        );
      const oversized = logicalResponse(`invalid-${"x".repeat(1024 * 1024)}`);
      const split = Math.ceil(oversized.byteLength / 2);
      expect(split).toBeGreaterThan(256 * 1024);
      for (let index = 0; index < 2; index += 1) {
        child.stdout.write(
          `${JSON.stringify({
            type: "rpc_chunk",
            chunkId: "oversized",
            index,
            count: 2,
            byteLength: oversized.byteLength,
            data: oversized.subarray(index * split, (index + 1) * split).toString("base64"),
          })}\n`,
        );
      }

      const valid = logicalResponse(`valid-${"x".repeat(1024 * 1024)}`);
      const count = Math.ceil(valid.byteLength / (256 * 1024));
      for (let index = 0; index < count; index += 1) {
        child.stdout.write(
          `${JSON.stringify({
            type: "rpc_chunk",
            chunkId: "valid",
            index,
            count,
            byteLength: valid.byteLength,
            data: valid.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
          })}\n`,
        );
      }

      const response = (await request) as { value: string };
      expect(response.value.startsWith("valid-")).toBe(true);
    } finally {
      await transport.close();
    }
  });
});
