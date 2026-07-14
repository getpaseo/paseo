import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { AgentSession, AgentStreamEvent } from "../../../agent-sdk-types.js";

type JsonObject = Record<string, unknown>;
type FakeCodexAppServerHandler = (params: unknown) => unknown;
interface FakeSubAgentActivity {
  callId: string;
  threadId: string;
  agentPath: string;
  kind: "started" | "interacted" | "interrupted";
  parentThreadId?: string;
}
interface FakeLegacyCommand {
  threadId: string;
  callId: string;
  command: string;
  output: string;
}
interface FakeSilentCommand {
  threadId: string;
  callId: string;
  command: string;
  cwd: string;
}
interface FakeTerminalInput {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
  text: string;
}
interface FakeLegacyPatch {
  threadId: string;
  callId: string;
  path: string;
  diff: string;
}
type CodexAppServerChildProcess = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

export interface FakeCodexAppServer {
  readonly child: CodexAppServerChildProcess;
  readonly recordedRollbacks: JsonObject[];
  assertNoErrors(): void;
  waitForTurnStart(): Promise<JsonObject>;
  nextResponse(): Promise<string>;
  startsTurn(params: { threadId: string; turnId?: string }): void;
  completeTurn(params?: { threadId?: string }): void;
  startsSubAgent(params: {
    callId: string;
    threadId: string;
    agentPath: string;
    parentThreadId?: string;
  }): void;
  beginsSubAgentActivity(params: FakeSubAgentActivity): void;
  completesSubAgentActivity(params: FakeSubAgentActivity): void;
  completesCompaction(params: { threadId: string; itemId: string }): void;
  runsLegacyCommand(params: FakeLegacyCommand): void;
  appliesLegacyPatch(params: FakeLegacyPatch): void;
  completesCommand(params: FakeLegacyCommand): void;
  completesSilentCommand(params: FakeSilentCommand): void;
  completesSilentLegacyCommand(params: FakeSilentCommand): void;
  typesIntoTerminal(params: FakeTerminalInput): void;
  says(params: { threadId: string; itemId?: string; text: string; chunks?: string[] }): void;
  requestCommandApproval(params: {
    itemId: string;
    threadId: string;
    turnId: string;
    command: string;
    cwd: string;
    reason: string;
  }): void;
  waitForCommandApprovalDecision(itemId: string): Promise<unknown>;
  requestMcpElicitation(params: {
    threadId: string;
    turnId: string | null;
    serverName: string;
    message: string;
    requestedSchema: Record<string, unknown>;
  }): void;
  waitForMcpElicitationDecision(): Promise<unknown>;
  resolvesMcpElicitation(): void;
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
  const recordedRollbacks: JsonObject[] = [];
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
    "thread/fork": (params) => ({
      thread: {
        id: "forked-thread",
        sessionId: "forked-session",
        forkedFromId: toJsonObject(params).threadId,
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
    "thread/rollback": (params) => {
      const rollback = toJsonObject(params);
      recordedRollbacks.push(rollback);
      return {
        thread: {
          id: typeof rollback.threadId === "string" ? rollback.threadId : "forked-thread",
          sessionId: "forked-session",
          forkedFromId: "thread-1",
          turns: [],
        },
      };
    },
    "thread/read": () => ({ thread: { turns: [] } }),
    ...handlers,
  };
  const messages: JsonObject[] = [];
  const errors: Error[] = [];
  const approvalRequestIds = new Map<string, number>();
  let mcpElicitationRequestId: number | undefined;
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

  function writeSubAgentActivity(
    method: "item/started" | "item/completed",
    params: FakeSubAgentActivity,
  ): void {
    writeNotification(method, {
      threadId: params.parentThreadId ?? "thread-1",
      item: {
        type: "subAgentActivity",
        id: params.callId,
        kind: params.kind,
        agentThreadId: params.threadId,
        agentPath: params.agentPath,
      },
    });
  }

  function writeNotification(method: string, params: JsonObject): void {
    child.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  function completeItem(threadId: string, item: JsonObject): void {
    writeNotification("item/completed", { threadId, item });
  }

  function writeLegacyEvent(threadId: string, method: string, msg: JsonObject): void {
    writeNotification(method, { threadId, msg });
  }

  return {
    child,
    recordedRollbacks,
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
    nextResponse() {
      return new Promise<string>((resolve) => {
        child.stdin.once("data", (chunk) => resolve(chunk.toString()));
      });
    },
    startsTurn(params) {
      child.stdout.write(
        `${JSON.stringify({
          method: "turn/started",
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId ?? `turn-${params.threadId}` },
          },
        })}\n`,
      );
    },
    completeTurn(params = {}) {
      child.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId: params.threadId ?? "thread-1", turn: { status: "completed" } },
        })}\n`,
      );
    },
    startsSubAgent(params) {
      writeSubAgentActivity("item/completed", { ...params, kind: "started" });
    },
    beginsSubAgentActivity(params) {
      writeSubAgentActivity("item/started", params);
    },
    completesSubAgentActivity(params) {
      writeSubAgentActivity("item/completed", params);
    },
    completesCompaction(params) {
      completeItem(params.threadId, { type: "contextCompaction", id: params.itemId });
    },
    runsLegacyCommand(params) {
      writeLegacyEvent(params.threadId, "codex/event/exec_command_begin", {
        type: "exec_command_begin",
        call_id: params.callId,
        command: params.command,
      });
      writeLegacyEvent(params.threadId, "codex/event/exec_command_output_delta", {
        type: "exec_command_output_delta",
        call_id: params.callId,
        chunk: params.output,
      });
      writeLegacyEvent(params.threadId, "codex/event/exec_command_end", {
        type: "exec_command_end",
        call_id: params.callId,
        command: params.command,
        exit_code: 0,
        success: true,
      });
    },
    appliesLegacyPatch(params) {
      const changes = [
        {
          path: params.path,
          kind: "modify",
          unified_diff: params.diff,
        },
      ];
      for (const [method, type] of [
        ["codex/event/patch_apply_begin", "patch_apply_begin"],
        ["codex/event/patch_apply_end", "patch_apply_end"],
      ] as const) {
        writeLegacyEvent(params.threadId, method, {
          type,
          call_id: params.callId,
          changes,
          ...(type === "patch_apply_end" ? { success: true } : {}),
        });
      }
    },
    completesCommand(params) {
      completeItem(params.threadId, {
        type: "commandExecution",
        id: params.callId,
        status: "completed",
        command: params.command,
        aggregatedOutput: params.output,
        exitCode: 0,
      });
    },
    completesSilentCommand(params) {
      completeItem(params.threadId, {
        type: "commandExecution",
        id: params.callId,
        status: "completed",
        command: params.command,
        cwd: params.cwd,
        aggregatedOutput: null,
        exitCode: 0,
      });
    },
    completesSilentLegacyCommand(params) {
      writeLegacyEvent(params.threadId, "codex/event/exec_command_end", {
        type: "exec_command_end",
        call_id: params.callId,
        command: params.command,
        cwd: params.cwd,
        aggregatedOutput: null,
        exit_code: 0,
        success: true,
      });
    },
    typesIntoTerminal(params) {
      writeNotification("item/commandExecution/terminalInteraction", {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        processId: params.processId,
        stdin: params.text,
      });
    },
    says(params) {
      if (params.itemId) {
        for (const chunk of params.chunks ?? [params.text]) {
          child.stdout.write(
            `${JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: params.threadId,
                itemId: params.itemId,
                delta: chunk,
              },
            })}\n`,
          );
        }
      }
      completeItem(params.threadId, {
        type: "agentMessage",
        ...(params.itemId ? { id: params.itemId } : {}),
        text: params.text,
      });
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
    requestMcpElicitation(params) {
      const requestId = nextServerRequestId;
      nextServerRequestId += 1;
      mcpElicitationRequestId = requestId;
      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "mcpServer/elicitation/request",
          params: {
            ...params,
            mode: "openai/form",
            _meta: null,
          },
        })}\n`,
      );
    },
    async waitForMcpElicitationDecision() {
      if (mcpElicitationRequestId === undefined) {
        throw new Error("No pending fake Codex app-server MCP elicitation");
      }
      const message = await waitForMessage(
        (candidate) =>
          candidate.id === mcpElicitationRequestId &&
          !("method" in candidate) &&
          "result" in candidate,
        "MCP elicitation response",
      );
      return message.result;
    },
    resolvesMcpElicitation() {
      if (mcpElicitationRequestId === undefined) {
        throw new Error("No pending fake Codex app-server MCP elicitation");
      }
      writeNotification("serverRequest/resolved", { requestId: mcpElicitationRequestId });
    },
  };
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

type StreamEventType = AgentStreamEvent["type"];
type StreamEventOfType<TType extends StreamEventType> = Extract<AgentStreamEvent, { type: TType }>;

function waitForNextEvent<TType extends StreamEventType>(
  session: AgentSession,
  type: TType,
  accepts?: (event: StreamEventOfType<TType>) => boolean,
): Promise<StreamEventOfType<TType>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1000);
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== type) {
        return;
      }
      const typedEvent = event as StreamEventOfType<TType>;
      if (accepts && !accepts(typedEvent)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(typedEvent);
    });
  });
}

type TimelineEvent = StreamEventOfType<"timeline">;

export function waitForNextPermission(
  session: AgentSession,
): Promise<StreamEventOfType<"permission_requested">> {
  return waitForNextEvent(session, "permission_requested");
}

export function waitForNextTimelineItem(session: AgentSession): Promise<TimelineEvent> {
  return waitForNextEvent(session, "timeline");
}

export function waitForTimelineToolCall(
  session: AgentSession,
  callId: string,
): Promise<TimelineEvent> {
  return waitForNextEvent(
    session,
    "timeline",
    (event) => event.item.type === "tool_call" && event.item.callId === callId,
  );
}
