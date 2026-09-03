import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

describe("Codex app-server transport", () => {
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

  // #2021: node:readline treats literal U+2028/U+2029 as line boundaries.
  // JSON.stringify escapes those code points; Codex app-server can emit the
  // literal characters inside JSON strings, so the fixture writes them raw.
  test("keeps unicode line separators inside one Codex JSONL record", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const calls: Array<{ method: string; params: unknown }> = [];
    client.setNotificationHandler((method, params) => {
      calls.push({ method, params });
    });

    const params = {
      text: "before\u2028middle\u2029after",
    };
    // Build the wire record with literal U+2028/U+2029 inside the JSON string.
    child.stdout.write(
      `{"method":"item/completed","params":{"text":"before\u2028middle\u2029after"}}\n`,
    );

    // Stream consumers process the write after the current turn.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual([
      {
        method: "item/completed",
        params,
      },
    ]);

    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("reassembles a Codex JSONL record split across stdout chunks", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const calls: Array<{ method: string; params: unknown }> = [];
    client.setNotificationHandler((method, params) => {
      calls.push({ method, params });
    });

    const params = {
      text: "chunk\u2028split\u2029record",
    };
    const record = `{"method":"item/completed","params":{"text":"chunk\u2028split\u2029record"}}\n`;
    const splitAt = Math.floor(record.length / 2);
    child.stdout.write(record.slice(0, splitAt));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual([]);

    child.stdout.write(record.slice(splitAt));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual([
      {
        method: "item/completed",
        params,
      },
    ]);

    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("accepts CRLF-terminated Codex JSONL records", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());
    const calls: Array<{ method: string; params: unknown }> = [];
    client.setNotificationHandler((method, params) => {
      calls.push({ method, params });
    });

    const params = {
      text: "crlf\u2028still\u2029data",
    };
    child.stdout.write(
      `{"method":"item/completed","params":{"text":"crlf\u2028still\u2029data"}}\r\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual([
      {
        method: "item/completed",
        params,
      },
    ]);

    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });
});
