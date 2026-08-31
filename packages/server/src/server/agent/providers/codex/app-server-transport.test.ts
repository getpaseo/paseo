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

  test("reverts a Codex thread before a turn through thread/revert", async () => {
    const codex = createFakeCodexAppServer({
      "thread/revert": (params) => {
        expect(params).toEqual({ threadId: "source-thread", beforeTurnId: "turn-first" });
        return {
          thread: {
            id: "source-thread",
            sessionId: "source-session",
            turns: [],
          },
          turnsBackwardsCursor: "turns-cursor",
          itemsBackwardsCursor: "items-cursor",
        };
      },
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const reverted = await client.revertThread({
      threadId: "source-thread",
      beforeTurnId: "turn-first",
    });

    expect(reverted.thread.id).toBe("source-thread");
    expect(reverted.turnsBackwardsCursor).toBe("turns-cursor");
    expect(reverted.itemsBackwardsCursor).toBe("items-cursor");
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });
});
