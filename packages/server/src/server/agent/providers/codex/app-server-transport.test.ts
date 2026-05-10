import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { CodexAppServerClient } from "./app-server-transport.js";

function createChildProcessStub(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

describe("Codex app-server transport", () => {
  test("ignores non-JSON stdout lines without dropping pending requests", async () => {
    const child = createChildProcessStub();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("model/list", {});
    child.stdout.write("Codex ha iniciado en modo localizado\n");
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("answers server-initiated requests through registered handlers", async () => {
    const child = createChildProcessStub();
    const client = new CodexAppServerClient(child, createTestLogger());
    client.setRequestHandler("tool/requestUserInput", async (params) => ({ echoed: params }));

    const response = new Promise<string>((resolve) => {
      child.stdin.once("data", (chunk) => resolve(chunk.toString()));
    });
    child.stdout.write(
      '{"id":7,"method":"tool/requestUserInput","params":{"prompt":"Continue?"}}\n',
    );

    await expect(response).resolves.toBe('{"id":7,"result":{"echoed":{"prompt":"Continue?"}}}\n');
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });
});
