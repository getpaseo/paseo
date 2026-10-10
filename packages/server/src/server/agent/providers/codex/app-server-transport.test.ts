import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

describe("Codex app-server transport", () => {
  test("preserves Unicode line and paragraph separators in notifications", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const notifications: unknown[] = [];
    client.setNotificationHandler((method, params) => notifications.push({ method, params }));
    const notification = {
      method: "item/agentMessage/delta",
      params: { delta: "before\u2028middle\u2029after" },
    };

    try {
      child.stdout.write(`${JSON.stringify(notification)}\n`);

      expect(notifications).toEqual([notification]);
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test.each([1, 7, 4096])("reads JSONL responses in %i-byte chunks", async (chunkSize) => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const history = { text: "before\u2028middle\u2029after 🚀 café" };
    const historyRequest = client.request("thread/read", { threadId: "thread-1" });
    const modelsRequest = client.request("model/list", {});
    const output = Buffer.from(
      `${JSON.stringify({ id: 1, result: history })}\r\n\n` +
        `${JSON.stringify({ id: 2, result: { data: [] } })}\n`,
    );

    try {
      for (let offset = 0; offset < output.length; offset += chunkSize) {
        child.stdout.write(output.subarray(offset, offset + chunkSize));
      }

      await expect(Promise.all([historyRequest, modelsRequest])).resolves.toEqual([
        history,
        { data: [] },
      ]);
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test("waits for LF before dispatching a complete JSON value", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const notifications: unknown[] = [];
    client.setNotificationHandler((method, params) => notifications.push({ method, params }));
    const notification = { method: "turn/completed", params: { threadId: "thread-1" } };

    try {
      child.stdout.write(`${JSON.stringify(notification)}\r`);
      expect(notifications).toEqual([]);

      child.stdout.write("\n");
      expect(notifications).toEqual([notification]);
    } finally {
      await client.dispose();
      child.stdout.end();
      child.stderr.end();
    }
  });

  test("reads the final response when stdout ends without LF", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const history = { text: "before\u2028after" };
    const request = client.request("thread/read", { threadId: "thread-1" });

    try {
      child.stdout.end(JSON.stringify({ id: 1, result: history }));

      await expect(request).resolves.toEqual(history);
    } finally {
      await client.dispose();
      child.stderr.end();
    }
  });

  test.each([0, 16, 1024])(
    "drains the final response when the child exits with stdout split at %i",
    async (splitAt) => {
      const child = createCodexAppServerChildProcess();
      const client = new CodexAppServerClient(child, createTestLogger());
      const terminated = vi.fn();
      client.setUnexpectedTerminationHandler(terminated);
      const history = { text: "before\u2028middle\u2029after 🚀" };
      const response = JSON.stringify({ id: 1, result: history });
      const request = client.request("thread/read", { threadId: "thread-1" });
      const unanswered = client.request("model/list", {}).catch((error: unknown) => error);

      try {
        child.stdout.write(response.slice(0, splitAt));
        child.emit("exit", 17, null);
        child.stdout.end(response.slice(splitAt));

        await expect(request).resolves.toEqual(history);
        expect(terminated).not.toHaveBeenCalled();

        child.stderr.end("final diagnostics");
        child.emit("close", 17, null);
        child.emit("close", 17, null);

        const error = new Error(
          "Codex app-server exited with code 17 and signal null\nfinal diagnostics",
        );
        await expect(unanswered).resolves.toEqual(error);
        expect(terminated).toHaveBeenCalledExactlyOnceWith(error);
      } finally {
        await client.dispose();
        child.stdout.end();
        child.stderr.end();
      }
    },
  );

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
