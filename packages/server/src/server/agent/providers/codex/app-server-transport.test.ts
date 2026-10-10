import { describe, expect, test, vi } from "vitest";
import { once } from "node:events";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

interface TestCodexRequest {
  id: number;
  method: string;
}

interface CodexTransportFixture {
  child: ReturnType<typeof createCodexAppServerChildProcess>;
  client: CodexAppServerClient;
}

interface ScheduleCodexWireOptions {
  child: ReturnType<typeof createCodexAppServerChildProcess>;
  wire: Buffer;
  chunkSize?: number;
  end?: boolean;
}

interface ScheduleCodexResponseOptions {
  child: ReturnType<typeof createCodexAppServerChildProcess>;
  requestId: number;
  text: string;
  escape?: boolean;
}

function parseCodexRequest(chunk: Buffer | string): TestCodexRequest {
  return JSON.parse(chunk.toString()) as TestCodexRequest;
}

function scheduleCodexWire({
  child,
  wire,
  chunkSize = wire.length,
  end = false,
}: ScheduleCodexWireOptions): void {
  queueMicrotask(() => {
    for (let offset = 0; offset < wire.length; offset += chunkSize) {
      child.stdout.write(wire.subarray(offset, offset + chunkSize));
    }
    if (end) {
      child.stdout.end();
    }
  });
}

function scheduleCodexResponse({
  child,
  requestId,
  text,
  escape,
}: ScheduleCodexResponseOptions): void {
  let response = JSON.stringify({ id: requestId, result: { text } });
  if (escape) {
    response = response.replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
  }
  const wire = Buffer.from(`${response}\n`, "utf8");
  for (const separator of [LS, PS]) {
    expect(wire.includes(Buffer.from(separator, "utf8"))).toBe(!escape && text.includes(separator));
  }
  scheduleCodexWire({ child, wire });
}

describe("Codex app-server transport", () => {
  test.each([
    { name: "ordinary text", text: "alpha beta" },
    { name: "raw U+2028", text: `alpha${LS}beta` },
    { name: "raw U+2029", text: `alpha${PS}beta` },
    { name: "raw U+2028 and U+2029", text: `alpha${LS}middle${PS}omega` },
    { name: "escaped U+2028 and U+2029", text: `alpha${LS}middle${PS}omega`, escape: true },
  ])("round-trips $name in an app-server response", async ({ text, escape }) => {
    const child = createCodexAppServerChildProcess();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const client = new CodexAppServerClient(child, logger);

    child.stdin.on("data", (chunk) => {
      const request = parseCodexRequest(chunk);
      expect(request.method).toBe("thread/read");
      scheduleCodexResponse({ child, requestId: request.id, text, escape });
    });

    try {
      await expect(client.request("thread/read", {}, 100)).resolves.toEqual({ text });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
      warn.mockRestore();
    }
  });

  test.each(["\n", "\r\n", "\r"])("preserves UTF-8 across byte chunks with %j", async (ending) => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const text = `中文${LS}emoji🙂${PS}\n\r"\\`;

    child.stdin.on("data", (chunk) => {
      const request = parseCodexRequest(chunk);
      const response = JSON.stringify({ id: request.id, result: { text } });
      scheduleCodexWire({ child, wire: Buffer.from(`${response}${ending}`, "utf8"), chunkSize: 1 });
    });

    try {
      await expect(client.request("thread/read", {}, 1000)).resolves.toEqual({ text });
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test("dispatches multiple JSON-RPC messages from one chunk", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.setNotificationHandler((method, params) => {
      notifications.push({ method, params });
    });

    child.stdin.on("data", (chunk) => {
      const request = parseCodexRequest(chunk);
      const response = JSON.stringify({ id: request.id, result: { text: `result${LS}${PS}` } });
      const notification = JSON.stringify({
        method: "turn/updated",
        params: { text: `notice${LS}${PS}` },
      });
      scheduleCodexWire({
        child,
        wire: Buffer.from(`${response}\r\n${notification}\r\n`, "utf8"),
      });
    });

    try {
      await expect(client.request("thread/read", {}, 1000)).resolves.toEqual({
        text: `result${LS}${PS}`,
      });
      expect(notifications).toEqual([
        { method: "turn/updated", params: { text: `notice${LS}${PS}` } },
      ]);
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test("accepts a final JSON-RPC frame at EOF", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const onNotification = vi.fn();
    client.setNotificationHandler(onNotification);

    child.stdin.on("data", (chunk) => {
      const request = parseCodexRequest(chunk);
      const response = JSON.stringify({ id: request.id, result: { text: `tail${LS}${PS}` } });
      scheduleCodexWire({ child, wire: Buffer.from(response, "utf8"), chunkSize: 3, end: true });
    });

    try {
      await expect(client.request("thread/read", {}, 1000)).resolves.toEqual({
        text: `tail${LS}${PS}`,
      });
      child.stdout.emit("data", Buffer.from('{"method":"turn/updated","params":{}}\n'));
      expect(onNotification).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      child.stderr.end();
    }
  });

  test("round-trips a 1 MiB response without truncation or duplication", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const suffix = `${LS}中文🙂${PS}`;
    const text = "x".repeat(1024 * 1024 - Buffer.byteLength(suffix)) + suffix;

    child.stdin.on("data", (chunk) => {
      const request = parseCodexRequest(chunk);
      const response = JSON.stringify({ id: request.id, result: { text } });
      scheduleCodexWire({
        child,
        wire: Buffer.from(`${response}\n`, "utf8"),
        chunkSize: 64 * 1024,
      });
    });

    try {
      await expect(client.request("thread/read", {}, 5000)).resolves.toEqual({ text });
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test("ignores non-JSON stdout lines without dropping pending requests", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("model/list", {});
    child.stdout.write("Codex ha iniciado en modo localizado\n");
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test.each([
    {
      name: "dispose",
      terminate: ({ client }: CodexTransportFixture) => client.dispose(),
      error: "Codex app-server client is closed",
    },
    {
      name: "child exit",
      terminate: ({ child }: CodexTransportFixture) => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      },
      error: "Codex app-server exited with code 1",
    },
    {
      name: "child error",
      terminate: ({ child }: CodexTransportFixture) => {
        child.emit("error", new Error("synthetic child error"));
      },
      error: "synthetic child error",
    },
  ])("rejects requests and ignores late stdout on $name", async ({ terminate, error }) => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const onNotification = vi.fn();
    client.setNotificationHandler(onNotification);
    const request = expect(client.request("thread/read", {}, 1000)).rejects.toThrow(error);

    try {
      child.stdout.write(Buffer.from('{"id":1,"result":{"text":"'));
      await terminate({ child, client });
      await request;
      child.stdout.emit(
        "data",
        Buffer.from('late response"}}\n{"method":"turn/updated","params":{}}\n'),
      );
      expect(onNotification).not.toHaveBeenCalled();
      await expect(client.request("thread/read", {}, 1000)).rejects.toThrow(
        "Codex app-server client is closed",
      );
    } finally {
      await client.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  test("discards an incomplete frame when stdout closes without EOF", async () => {
    const child = createCodexAppServerChildProcess();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const client = new CodexAppServerClient(child, logger);
    const onNotification = vi.fn();
    client.setNotificationHandler(onNotification);

    try {
      child.stdout.write(Buffer.from('{"method":"turn/updated","params":{"text":"'));
      const closed = once(child.stdout, "close");
      child.stdout.destroy();
      await closed;

      child.stdout.emit(
        "data",
        Buffer.from('late notification"}}\n{"method":"turn/updated","params":{}}\n'),
      );
      expect(onNotification).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      warn.mockRestore();
    }
  });

  test("stops framing the current chunk when a notification disposes the client", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    let closing = Promise.resolve();
    const onNotification = vi.fn(() => {
      closing = client.dispose();
    });
    client.setNotificationHandler(onNotification);

    try {
      const notification = JSON.stringify({ method: "turn/updated", params: {} });
      child.stdout.write(Buffer.from(`${notification}\n${notification}\n${"x".repeat(1024)}`));
      await closing;

      expect(onNotification).toHaveBeenCalledTimes(1);
    } finally {
      await client.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  test("preserves other stdout listeners when disposal happens during a data event", async () => {
    const child = createCodexAppServerChildProcess();
    let closing = Promise.resolve();
    const onData = vi.fn();
    child.stdout.on("data", onData);
    child.stdout.once("data", () => {
      closing = client.dispose();
    });
    const client = new CodexAppServerClient(child, createTestLogger());
    const onNotification = vi.fn();
    client.setNotificationHandler(onNotification);

    try {
      const wire = Buffer.from('{"method":"turn/updated","params":{}}\n');
      child.stdout.write(wire);
      await closing;

      child.stdout.write(wire);
      expect(onData.mock.calls).toEqual([[wire], [wire]]);
      expect(onNotification).not.toHaveBeenCalled();
    } finally {
      child.stdout.off("data", onData);
      await client.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  test("dispose rejects pending requests instead of leaving them hanging", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("initialize", {});
    await client.dispose();

    await expect(request).rejects.toThrow("Codex app-server client is closed");
  });

  test("dispose rejects until the child has actually exited", async () => {
    vi.useFakeTimers();
    const child = createCodexAppServerChildProcess();
    child.kill = () => true;
    const client = new CodexAppServerClient(child, createTestLogger());
    try {
      for (let i = 0; i < 2; i++) {
        const closing = expect(client.dispose()).rejects.toThrow(
          "did not report exit after SIGKILL",
        );
        await vi.advanceTimersByTimeAsync(3_000);
        await closing;
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await expect(client.dispose()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
  ])("answers server-initiated %s requests through registered handlers", async (method) => {
    const codex = createFakeCodexAppServer();
    const client = new CodexAppServerClient(codex.child, createTestLogger());
    const handlerCalls: unknown[] = [];
    client.setRequestHandler(method, async (params) => {
      handlerCalls.push(params);
      return { ok: true };
    });

    const response = codex.nextResponse();
    codex.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {} })}\n`);

    await expect(response).resolves.toBe('{"id":7,"result":{"ok":true}}\n');
    expect(handlerCalls).toEqual([{}]);
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("forks a Codex thread through thread/fork", async () => {
    const codex = createFakeCodexAppServer({
      "thread/fork": (params) => ({
        thread: {
          id: "forked-thread",
          sessionId: "forked-session",
          forkedFromId: (params as { threadId?: string }).threadId,
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace/project",
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: null,
        sandbox: { type: "workspaceWrite", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: null,
      }),
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const forked = await client.forkThread({
      threadId: "source-thread",
      cwd: "/workspace/project",
      excludeTurns: true,
    });

    expect(forked.thread.id).toBe("forked-thread");
    expect(forked.thread.forkedFromId).toBe("source-thread");
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("rolls back a Codex thread by N turns", async () => {
    const codex = createFakeCodexAppServer({
      "thread/rollback": (params) => {
        expect(params).toEqual({ threadId: "forked-thread", numTurns: 2 });
        return {
          thread: {
            id: "forked-thread",
            sessionId: "forked-session",
            turns: [{ id: "remaining-turn" }],
          },
        };
      },
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const rolledBack = await client.rollbackThread({
      threadId: "forked-thread",
      numTurns: 2,
    });

    expect(rolledBack.thread.id).toBe("forked-thread");
    expect(rolledBack.thread.turns).toEqual([{ id: "remaining-turn" }]);
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });
});
