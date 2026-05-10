import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { AgentSession, AgentStreamEvent } from "../../../agent-sdk-types.js";

type JsonObject = Record<string, unknown>;
type FakeCodexAppServerHandler = (params: unknown) => unknown;
type CodexAppServerChildProcess = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

export interface FakeCodexAppServer {
  readonly child: CodexAppServerChildProcess;
  assertNoErrors(): void;
  waitForTurnStart(): Promise<JsonObject>;
  requestCommandApproval(params: {
    itemId: string;
    threadId: string;
    turnId: string;
    command: string;
    cwd: string;
    reason: string;
  }): void;
  waitForCommandApprovalDecision(itemId: string): Promise<unknown>;
}

export function createCodexAppServerChildProcess(): CodexAppServerChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as CodexAppServerChildProcess;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

export function createFakeCodexAppServer(
  handlers: Record<string, FakeCodexAppServerHandler> = {},
): FakeCodexAppServer {
  const child = createCodexAppServerChildProcess();
  const responseHandlers: Record<string, FakeCodexAppServerHandler> = {
    initialize: () => ({}),
    "collaborationMode/list": () => ({ data: [] }),
    "config/read": () => ({ config: {} }),
    getUserSavedConfig: () => ({ config: {} }),
    "model/list": () => ({
      data: [
        {
          id: "gpt-5.4",
          isDefault: true,
          defaultReasoningEffort: "medium",
        },
      ],
    }),
    "skills/list": () => ({ data: [] }),
    "thread/start": () => ({ thread: { id: "thread-1" } }),
    "thread/loaded/list": () => ({ data: [] }),
    "thread/resume": () => ({}),
    "turn/start": () => ({}),
    ...handlers,
  };
  const messages: JsonObject[] = [];
  const errors: Error[] = [];
  const approvalRequestIds = new Map<string, number>();
  const waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
  }>();
  let buffer = "";
  let nextServerRequestId = 1;

  function processMessage(message: JsonObject): void {
    messages.push(message);
    for (const waiter of Array.from(waiters)) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }

    if (typeof message.id !== "number" || typeof message.method !== "string") {
      return;
    }

    const handler = responseHandlers[message.method];
    if (!handler) {
      errors.push(new Error(`Unexpected Codex app-server request: ${message.method}`));
      return;
    }

    Promise.resolve(handler(message.params))
      .then((result) => {
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        return undefined;
      })
      .catch((error) => {
        child.stdout.write(
          `${JSON.stringify({
            id: message.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          })}\n`,
        );
        return undefined;
      });
  }

  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          processMessage(parsed as JsonObject);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  function waitForMessage(
    predicate: (message: JsonObject) => boolean,
    label: string,
  ): Promise<JsonObject> {
    const existing = messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, 1000);
      const waiter = {
        predicate,
        resolve: (message: JsonObject) => {
          clearTimeout(timeout);
          resolve(message);
        },
      };
      waiters.add(waiter);
    });
  }

  return {
    child,
    assertNoErrors() {
      if (errors.length > 0) {
        throw errors[0];
      }
    },
    async waitForTurnStart() {
      const message = await waitForMessage(
        (candidate) => candidate.method === "turn/start",
        "turn start request",
      );
      return toJsonObject(message.params);
    },
    requestCommandApproval(params) {
      const requestId = nextServerRequestId;
      nextServerRequestId += 1;
      approvalRequestIds.set(params.itemId, requestId);
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params,
        })}\n`,
      );
    },
    async waitForCommandApprovalDecision(itemId) {
      const requestId = approvalRequestIds.get(itemId);
      if (requestId === undefined) {
        throw new Error(`No pending fake Codex app-server approval for ${itemId}`);
      }
      const message = await waitForMessage(
        (candidate) =>
          candidate.id === requestId && !("method" in candidate) && "result" in candidate,
        "command approval response",
      );
      return message.result;
    },
  };
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

export function waitForNextPermission(
  session: AgentSession,
): Promise<Extract<AgentStreamEvent, { type: "permission_requested" }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for permission_requested"));
    }, 1000);
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "permission_requested") {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}
