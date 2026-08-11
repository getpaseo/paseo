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
      const logical = JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { value: "chunked-ok" },
      });
      const bytes = Buffer.from(logical, "utf8");
      const chunkPayload = 64;
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

      await expect(request).resolves.toEqual({ value: "chunked-ok" });
    } finally {
      await transport.close();
    }
  });
});
