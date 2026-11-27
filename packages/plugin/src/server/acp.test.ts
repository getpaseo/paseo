import type { ChildProcess } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "./provider.js";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { runAcpProvider, type AcpStreamMessage } from "./acp.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fakeAcp(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-acp-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "agent.cjs");
  await writeFile(executable, source, "utf8");
  return executable;
}

async function connect(
  executable: string,
  capabilities: string[],
  transformers?: Parameters<typeof runAcpProvider>[0]["transformers"],
): Promise<{ connection: ProviderConnection; events: ProviderEvent[] }> {
  const registration = runAcpProvider({
    id: "test-acp",
    label: "Test ACP",
    command: [process.execPath, executable],
    transformers,
  });
  const connection = await registration.connect({ versions: [1], capabilities });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { connection, events };
}

function openInput(
  settings: Record<string, string> = {},
): Extract<ProviderInput, { type: "session.open" }> {
  return {
    type: "session.open",
    requestId: "open-1",
    sessionId: "session-1",
    config: { cwd: process.cwd(), env: {}, mcpServers: {}, settings, persist: true },
    history: "skip",
  };
}

async function waitForEvent(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => boolean,
): Promise<ProviderEvent> {
  await expect.poll(() => events.find(predicate), { timeout: 3_000 }).toBeTruthy();
  return events.find(predicate)!;
}

interface ModelThinking {
  id: string;
  thinkingOptions?: readonly { id: string }[];
  defaultThinkingOptionId?: string;
}

function modelThinking(model: ModelThinking) {
  return {
    id: model.id,
    thinkingOptions: model.thinkingOptions?.map(optionId),
    defaultThinkingOptionId: model.defaultThinkingOptionId,
  };
}

function optionId(option: { id: string }): string {
  return option.id;
}

type AcpRequestMessage = Extract<AcpStreamMessage, { id: string | number | null; method: string }>;

interface ConnectorInstance {
  readonly requests: AcpRequestMessage[];
  readsCanceled: boolean;
  writesClosed: boolean;
  closeFromAgent(): void;
  request(method: string, params: unknown): Promise<unknown>;
  respond(request: AcpRequestMessage, result: unknown): void;
  reject(request: AcpRequestMessage, message: string): void;
  notify(method: string, params: unknown): void;
}

interface ConnectorResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ConnectorHarnessOptions {
  capabilities?: Record<string, unknown>;
  configOptions?: unknown[];
  /** Session updates the agent streams for a prompt (keyed by its text) before ending the turn. */
  promptUpdates?(promptText: string): unknown[];
  handleMessage?(instance: ConnectorInstance, message: AcpStreamMessage): boolean;
  handleRequest?(instance: ConnectorInstance, request: AcpRequestMessage): boolean;
}

function countRequests(instance: ConnectorInstance, method: string): number {
  return instance.requests.filter((request) => request.method === method).length;
}

function receiveConnectorMessage(
  instance: ConnectorInstance,
  message: AcpStreamMessage,
  options?: ConnectorHarnessOptions,
): void {
  if (!("method" in message)) return;
  if ("id" in message) instance.requests.push(message as AcpRequestMessage);
  if (options?.handleMessage?.(instance, message)) return;
  if (!("id" in message)) return;
  const request = message as AcpRequestMessage;
  if (options?.handleRequest?.(instance, request)) return;
  respondToConnectorRequest(instance, request, options);
}

function respondToConnectorRequest(
  instance: ConnectorInstance,
  request: AcpRequestMessage,
  options?: ConnectorHarnessOptions,
): void {
  if (request.method === "initialize") {
    instance.respond(request, {
      protocolVersion: request.params
        ? (request.params as { protocolVersion: number }).protocolVersion
        : PROTOCOL_VERSION,
      agentCapabilities: options?.capabilities ?? {},
    });
  } else if (request.method === "session/new" || request.method === "session/load") {
    instance.respond(request, {
      sessionId: "connector-session",
      modes: null,
      configOptions: options?.configOptions ?? [],
    });
  } else if (request.method === "session/prompt") {
    const { prompt } = request.params as { prompt: Array<{ type: string; text?: string }> };
    const promptText = prompt.find((part) => part.type === "text")?.text ?? "";
    for (const update of options?.promptUpdates?.(promptText) ?? []) {
      instance.notify("session/update", { sessionId: "connector-session", update });
    }
    instance.respond(request, { stopReason: "end_turn" });
  } else if (request.method === "session/close") {
    instance.respond(request, {});
  } else if (request.method === "session/set_config_option") {
    const params = request.params as { configId: string; value: string | boolean };
    instance.respond(request, {
      configOptions: (options?.configOptions ?? []).map((option) =>
        (option as { id?: string }).id === params.configId
          ? Object.assign({}, option, { currentValue: params.value })
          : option,
      ),
    });
  }
}

function connectorHarness(options?: ConnectorHarnessOptions) {
  const instances: ConnectorInstance[] = [];
  const connector = () => {
    let controller!: ReadableStreamDefaultController<AcpStreamMessage>;
    let requestSequence = 0;
    const responses = new Map<number, ConnectorResponse>();
    const instance: ConnectorInstance = {
      requests: [],
      readsCanceled: false,
      writesClosed: false,
      closeFromAgent: () => controller.close(),
      request: (method, params) => {
        const response = new Promise<unknown>((resolve, reject) => {
          requestSequence += 1;
          responses.set(requestSequence, { resolve, reject });
          controller.enqueue({ jsonrpc: "2.0", id: requestSequence, method, params });
        });
        void response.catch(() => undefined);
        return response;
      },
      respond: (request, result) => controller.enqueue({ jsonrpc: "2.0", id: request.id, result }),
      reject: (request, message) =>
        controller.enqueue({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } }),
      notify: (method, params) => controller.enqueue({ jsonrpc: "2.0", method, params }),
    };
    instances.push(instance);
    const readable = new ReadableStream<AcpStreamMessage>({
      start(value) {
        controller = value;
      },
      cancel() {
        instance.readsCanceled = true;
      },
    });
    const writable = new WritableStream<AcpStreamMessage>({
      write(message) {
        if (!("method" in message)) {
          if (typeof message.id !== "number") return;
          const response = responses.get(message.id);
          if (!response) return;
          responses.delete(message.id);
          if ("error" in message) {
            response.reject(
              new Error(
                message.error.data === undefined
                  ? message.error.message
                  : `${message.error.message}: ${JSON.stringify(message.error.data)}`,
              ),
            );
          } else response.resolve(message.result);
          return;
        }
        receiveConnectorMessage(instance, message, options);
      },
      close() {
        instance.writesClosed = true;
      },
      abort() {
        instance.writesClosed = true;
      },
    });
    return { readable, writable };
  };
  return { connector, instances };
}

const basicAgent = `const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } }), 150);
  else if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});`;

describe("runAcpProvider", () => {
  it.each(["replay", "skip"] as const)(
    "handles trailing load updates with %s history",
    async (history) => {
      const sessionId = "connector-session";
      const notifyUpdate = (runtime: ConnectorInstance, update: unknown) =>
        runtime.notify("session/update", { sessionId, update });
      const { connector, instances } = connectorHarness({
        capabilities: { loadSession: true },
        handleRequest(runtime, request) {
          if (request.method !== "session/load") return false;
          notifyUpdate(runtime, {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "help", description: "Help" }],
          });
          runtime.respond(request, { configOptions: [] });
          setTimeout(() => {
            notifyUpdate(runtime, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "previous question" },
            });
            notifyUpdate(runtime, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "previous answer" },
            });
          }, 100);
          return true;
        },
      });
      const connection = await runAcpProvider({
        id: "load",
        label: "Load",
        connector,
        acpOptions: {
          waitForInitialCommands: true,
          initialCommandsTimeoutMs: 10_000,
          loadReplayQuietPeriodMs: 200,
        },
      }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send({
          ...openInput(),
          history,
          persistence: { version: 1, data: { sessionId } },
        });
        await waitForEvent(events, (event) => event.type === "session.ready");
        notifyUpdate(instances[1], {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stale history outside the replay window" },
        });
        notifyUpdate(instances[1], {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "different", description: "Different" }],
        });
        await waitForEvent(
          events,
          (event) => event.type === "session.commands" && event.commands[0]?.name === "different",
        );
        const items = events
          .filter((event) => event.type === "timeline.item")
          .map((event) => event.item);
        expect(items).toEqual(
          history === "skip"
            ? []
            : [
                expect.objectContaining({ type: "user_message", text: "previous question" }),
                expect.objectContaining({ type: "assistant_message", text: "previous answer" }),
              ],
        );
        expect(events.some((event) => event.type === "session.turn")).toBe(false);
      } finally {
        await connection.close();
      }
    },
  );

  it("keeps history that streams after session/load for longer than five quiet periods", async () => {
    const sessionId = "connector-session";
    const historyLength = 40;
    let stream: ReturnType<typeof setInterval> | undefined;
    const { connector } = connectorHarness({
      capabilities: { loadSession: true },
      handleRequest(runtime, request) {
        if (request.method !== "session/load") return false;
        runtime.respond(request, { configOptions: [] });
        let sent = 0;
        stream = setInterval(() => {
          runtime.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `answer-${sent}`,
              content: { type: "text", text: `previous answer ${sent}` },
            },
          });
          sent += 1;
          if (sent === historyLength) clearInterval(stream);
        }, 20);
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "load",
      label: "Load",
      connector,
      acpOptions: { loadReplayQuietPeriodMs: 100 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(events.filter((event) => event.type === "timeline.item")).toHaveLength(historyLength);
    } finally {
      clearInterval(stream);
      await connection.close();
    }
  });

  it("closes without waiting for history that is still streaming after session/load", async () => {
    const sessionId = "connector-session";
    let stream: ReturnType<typeof setInterval> | undefined;
    const { connector } = connectorHarness({
      capabilities: { loadSession: true },
      handleRequest(runtime, request) {
        if (request.method !== "session/load") return false;
        runtime.respond(request, { configOptions: [] });
        stream = setInterval(() => {
          if (runtime.readsCanceled) return;
          runtime.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "previous answer" },
            },
          });
        }, 20);
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "load",
      label: "Load",
      connector,
      acpOptions: { loadReplayQuietPeriodMs: 100 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId } },
      });
      await waitForEvent(events, (event) => event.type === "timeline.item");
      const outcome = await Promise.race([
        connection.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("still replaying"), 1_000)),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      clearInterval(stream);
    }
  });

  it("keeps history left unread while the event loop stalled past the quiet period", async () => {
    const sessionId = "connector-session";
    const notifyAnswer = (runtime: ConnectorInstance, text: string) =>
      runtime.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: text,
          content: { type: "text", text },
        },
      });
    const { connector } = connectorHarness({
      capabilities: { loadSession: true },
      handleRequest(runtime, request) {
        if (request.method !== "session/load") return false;
        runtime.respond(request, { configOptions: [] });
        notifyAnswer(runtime, "read before the stall");
        // Stall after the timers phase, so the overdue quiet timer runs before the next I/O poll.
        const stall = () => {
          // Like bytes waiting in the agent's pipe: readable only once the loop polls I/O again.
          setImmediate(() => notifyAnswer(runtime, "unread during the stall"));
          const stalledUntil = performance.now() + 250;
          while (performance.now() < stalledUntil);
        };
        setTimeout(() => setImmediate(stall), 30);
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "load",
      label: "Load",
      connector,
      acpOptions: { loadReplayQuietPeriodMs: 100 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(
        events.filter((event) => event.type === "timeline.item").map((event) => event.item),
      ).toEqual([
        expect.objectContaining({ text: "read before the stall" }),
        expect.objectContaining({ text: "unread during the stall" }),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("does not extend the load replay wait for session_info_update notifications", async () => {
    const sessionId = "connector-session";
    let stream: ReturnType<typeof setInterval> | undefined;
    const { connector } = connectorHarness({
      capabilities: { loadSession: true },
      handleRequest(runtime, request) {
        if (request.method !== "session/load") return false;
        runtime.respond(request, { configOptions: [] });
        runtime.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-1",
            content: { type: "text", text: "previous answer" },
          },
        });
        stream = setInterval(() => {
          if (runtime.readsCanceled) return;
          runtime.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "session_info_update",
              title: "Updated title",
            },
          });
        }, 20);
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "load",
      label: "Load",
      connector,
      acpOptions: { loadReplayQuietPeriodMs: 100 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId } },
      });
      const outcome = await Promise.race([
        waitForEvent(events, (event) => event.type === "session.ready").then(() => "ready"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
      ]);
      expect(outcome).toBe("ready");
      expect(events.filter((event) => event.type === "timeline.item")).toHaveLength(1);
    } finally {
      clearInterval(stream);
      await connection.close();
    }
  });

  it("fails session open without emitting session.ready or leaking the session when the ACP process crashes mid-replay", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-crash-replay-"));
    const script = path.join(dir, "crash-replay-agent.mjs");
    await writeFile(
      script,
      `
      import { createInterface } from "node:readline";
      const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === "session/load") {
          const sid = msg.params.sessionId;
          send({ id: msg.id, result: { configOptions: [] } });
          send({
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "m-1",
                content: { type: "text", text: "partial history" },
              },
            },
          });
          if (sid === "crash-session") {
            setTimeout(() => process.exit(1), 20);
          }
        } else if (msg.method === "session/close") {
          send({ id: msg.id, result: {} });
        }
      });
      `,
    );
    const connection = await runAcpProvider({
      id: "crash-replay",
      label: "Crash Replay",
      command: [process.execPath, script],
      acpOptions: { loadReplayQuietPeriodMs: 100 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        ...openInput(),
        requestId: "req-crash",
        sessionId: "session-1",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "crash-session" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.failed" && event.requestId === "req-crash",
      );
      expect(events.some((event) => event.type === "session.ready")).toBe(false);

      // The failed open must not leave a dead session registered under "session-1".
      await connection.send({
        ...openInput(),
        requestId: "req-retry",
        sessionId: "session-1",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "healthy-session" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.ready" && event.requestId === "req-retry",
      );
    } finally {
      await connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a multi-read tool result started during an event-loop stall past the quiet period", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-large-stall-replay-"));
    const script = path.join(dir, "large-stall-agent.mjs");
    const outputBytes = 256 * 1024;
    await writeFile(
      script,
      `
      import { createInterface } from "node:readline";
      const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === "session/load") {
          const sid = msg.params.sessionId;
          send({
            method: "session/update",
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "m-before",
                content: { type: "text", text: "before the stall" },
              },
            },
          });
          send({ id: msg.id, result: { configOptions: [] } });
          setTimeout(() => {
            send({
              method: "session/update",
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "shell-large",
                  name: "run_command",
                  title: "Large output",
                  kind: "execute",
                  status: "completed",
                  rawInput: { CommandLine: "cat large.log" },
                  rawOutput: { output: "x".repeat(${outputBytes}), exit_code: 0 },
                },
              },
            });
          }, 50);
        } else if (msg.method === "session/close") {
          send({ id: msg.id, result: {} });
        }
      });
      `,
    );
    const connection = await runAcpProvider({
      id: "large-stall",
      label: "Large Stall",
      command: [process.execPath, script],
      acpOptions: { loadReplayQuietPeriodMs: 200 },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.persistence"] });
    const events: ProviderEvent[] = [];
    let stalled = false;
    const stallEventLoop = () => {
      const until = performance.now() + 350;
      while (performance.now() < until);
    };
    const scheduleStall = () => setImmediate(stallEventLoop);
    connection.onEvent((event) => {
      events.push(event);
      if (!stalled && event.type === "session.config") {
        stalled = true;
        // Stall after the timers phase so the overdue quiet timer runs before the next I/O poll;
        // the 256 KiB tool result fills the pipe during the stall and spans multiple stdout reads.
        setTimeout(scheduleStall, 20);
      }
    });
    try {
      await connection.send({
        ...openInput(),
        history: "replay",
        persistence: { version: 1, data: { sessionId: "large-session" } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      const items = events
        .filter((event) => event.type === "timeline.item")
        .map((event) => event.item);
      expect(items).toEqual([
        expect.objectContaining({ type: "assistant_message", text: "before the stall" }),
        expect.objectContaining({ type: "tool_call", callId: "shell-large", status: "completed" }),
      ]);
    } finally {
      await connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("auto-accepts ordinary permissions only in the unattended mode and refuses to switch while busy", async () => {
    const modeConfig = {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    };
    const approval = {
      sessionId: "connector-session",
      toolCall: { toolCallId: "tool", title: "Write a file", rawInput: {} },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
    let finishPrompt: (() => void) | undefined;
    let stopping = false;
    const outcomes: unknown[] = [];
    const { connector } = connectorHarness({
      configOptions: [modeConfig],
      handleMessage(_runtime, message) {
        if (!("method" in message) || message.method !== "session/cancel") return false;
        stopping = true;
        return true;
      },
      handleRequest(runtime, request) {
        if (request.method !== "session/prompt") return false;
        void runtime.request("session/request_permission", approval).then((outcome) => {
          outcomes.push(outcome);
          if (stopping) {
            stopping = false;
            runtime.respond(request, { stopReason: "cancelled" });
          } else {
            finishPrompt = () => runtime.respond(request, { stopReason: "end_turn" });
          }
          return undefined;
        });
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "unattended",
      label: "Unattended",
      connector,
      acpOptions: {
        autoAcceptMode: {
          mode: { id: "full-access", label: "Full access" },
          nativeMode: "default",
          default: true,
        },
      },
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.configure", "permission"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const configure = async (requestId: string, mode: string) => {
      await connection.send({
        type: "session.configure",
        requestId,
        sessionId: "session-1",
        changes: { mode },
      });
      return waitForEvent(events, (event) => "requestId" in event && event.requestId === requestId);
    };
    const prompt = (id: string) =>
      connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: id,
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: id }] },
        },
      });
    try {
      await connection.send({ type: "catalog", requestId: "catalog" });
      expect(await waitForEvent(events, (event) => event.type === "catalog")).toMatchObject({
        catalog: {
          defaultMode: "full-access",
          modes: expect.arrayContaining([
            { id: "full-access", label: "Full access", isUnattended: true },
          ]),
        },
      });
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await prompt("unattended");
      await expect
        .poll(() => outcomes[0])
        .toEqual({ outcome: { outcome: "selected", optionId: "once" } });
      expect(events.some((event) => event.type === "session.permission")).toBe(false);
      expect(await configure("busy", "plan")).toMatchObject({ type: "request.failed" });
      finishPrompt!();
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "completed",
      );
      expect(await configure("leave", "default")).toMatchObject({ type: "request.completed" });

      await prompt("interactive");
      await waitForEvent(events, (event) => event.type === "session.permission");
      expect(await configure("pending", "full-access")).toMatchObject({ type: "request.failed" });
      expect(outcomes).toHaveLength(1);
      await connection.send({
        type: "session.interrupt",
        requestId: "stop",
        sessionId: "session-1",
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:interactive" &&
          event.state === "canceled",
      );
      await expect.poll(() => outcomes[1]).toEqual({ outcome: { outcome: "cancelled" } });
      await connection.send({
        type: "session.permission",
        sessionId: "session-1",
        permissionId: "permission:tool",
        response: { behavior: "allow" },
      });
      expect(await configure("enter", "full-access")).toMatchObject({ type: "request.completed" });
      expect(events.some((event) => event.type === "session.runtime_failed")).toBe(false);
      expect(
        events.filter((event) => event.type === "session.config").map((event) => event.config.mode),
      ).toEqual(["full-access", "default", "full-access"]);
    } finally {
      await connection.close();
    }
  });

  it("accepts a prompt as soon as the session reports ready", async () => {
    const { connector } = connectorHarness();
    const connection = await runAcpProvider({
      id: "ready-acp",
      label: "Ready ACP",
      connector,
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    try {
      const prompted = Promise.withResolvers<void>();
      connection.onEvent((event) => {
        if (event.type !== "session.ready") return;
        void connection
          .send({
            type: "session.prompt",
            sessionId: event.sessionId!,
            prompt: {
              clientMessageId: "first",
              delivery: "auto",
              input: { type: "message", content: [{ type: "text", text: "Hi" }] },
            },
          })
          .then(prompted.resolve, prompted.reject);
      });
      await connection.send(openInput());
      await prompted.promise;
    } finally {
      await connection.close();
    }
  });

  it("uses config options for mode selection when the agent exposes no legacy modes", async () => {
    const { connector } = connectorHarness({
      configOptions: [
        {
          id: "permissions",
          category: "mode",
          name: "Permissions",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "edit", name: "Accept edits" },
          ],
        },
      ],
    });
    const connection = await runAcpProvider({ id: "modes", label: "Modes", connector }).connect({
      versions: [1],
      capabilities: ["session.configure"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      const input = openInput();
      input.config.mode = "edit";
      await connection.send(input);
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "session.config" || event.type === "request.failed",
        ),
      ).toMatchObject({
        type: "session.config",
        config: { mode: "edit", modes: [{ id: "default" }, { id: "edit" }], settings: [] },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.configure",
        requestId: "default",
        sessionId: input.sessionId,
        changes: { mode: "default" },
      });
      expect(
        await waitForEvent(
          events,
          (event) => event.type === "session.config" && event.config.mode === "default",
        ),
      ).toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it("spawns the daemon-resolved launch for probes, catalogues, listing, and sessions", async () => {
    const executable = await fakeAcp(`
if (process.env.LAUNCH_TOKEN !== "resolved" || process.env.CLAUDECODE || process.env.PASEO_NODE_ENV) process.exit(1);
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  let result;
  if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, agentCapabilities: { sessionCapabilities: { list: {} } } };
  else if (message.method === "session/new") result = { sessionId: "native", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "resolved", options: [{ value: "resolved", name: require("node:fs").realpathSync(message.params.cwd) === process.cwd() ? (process.env.SESSION_TOKEN || "probe") : "wrong cwd" }] }] };
  else if (message.method === "session/list") result = { sessions: [] };
  else return;
  send({ jsonrpc: "2.0", id: message.id, result });
});`);
    const registration = runAcpProvider({
      id: "launch-acp",
      label: "Launch ACP",
      command: ["missing-default-command"],
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.list"],
      launch: { command: process.execPath, args: [executable], env: { LAUNCH_TOKEN: "resolved" } },
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "catalog",
        requestId: "catalog",
        cwd: path.dirname(executable),
      });
      expect(await waitForEvent(events, (event) => event.type === "catalog")).toMatchObject({
        catalog: { models: [{ id: "resolved", label: "probe" }] },
      });
      await connection.send({ type: "sessions", requestId: "list" });
      expect(await waitForEvent(events, (event) => event.type === "sessions")).toMatchObject({
        sessions: [],
      });
      const input = openInput();
      input.config.env = { SESSION_TOKEN: "session" };
      input.config.cwd = path.dirname(executable);
      await connection.send(input);
      expect(await waitForEvent(events, (event) => event.type === "session.config")).toMatchObject({
        config: { models: [{ id: "resolved", label: "session" }] },
      });
    } finally {
      await connection.close();
    }
  });

  it("short-circuits workspace-only global discovery with zero spawns", async () => {
    let unavailable = false;
    const harness = connectorHarness({
      handleRequest(instance, request) {
        if (unavailable && request.method === "initialize") {
          instance.reject(request, "Bridge unavailable");
          return true;
        }
        return false;
      },
    });
    const registration = runAcpProvider({
      id: "workspace-acp",
      label: "Workspace ACP",
      connector: harness.connector,
      acpOptions: { workspaceOnlyCatalog: true },
    });
    expect(registration.getCatalogCacheKey).toBeUndefined();
    const connection = await registration.connect({ versions: [1], capabilities: [] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      unavailable = true;
      const spawnsBefore = harness.instances.length;
      await connection.send({ type: "catalog", requestId: "global" });
      expect(await waitForEvent(events, (event) => event.type === "catalog")).toEqual({
        type: "catalog",
        requestId: "global",
        catalog: { models: [], modes: [] },
      });
      expect(harness.instances.length).toBe(spawnsBefore);
    } finally {
      await connection.close();
    }
  });

  it("rejects connection cleanly when the ACP executable does not exist", async () => {
    const registration = runAcpProvider({
      id: "missing-acp",
      label: "Missing ACP",
      command: [path.join(tmpdir(), `missing-acp-${process.pid}`)],
      acpOptions: { startupTimeoutMs: 250 },
    });

    await expect(
      registration.connect({ versions: [1], capabilities: ["prompt.message"] }),
    ).rejects.toThrow(/ENOENT|spawn/u);
  });

  it("accepts an official ACP SDK stream connector instead of a command", async () => {
    const connector = () => {
      const clientToAgent = new TransformStream();
      const agentToClient = new TransformStream();
      const agent: Agent = {
        initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
        newSession: async () => ({ sessionId: "sdk-session", modes: null, configOptions: [] }),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      };
      const agentConnection = new AgentSideConnection(() => agent, {
        writable: agentToClient.writable,
        readable: clientToAgent.readable,
      });
      void agentConnection;
      return {
        writable: clientToAgent.writable,
        readable: agentToClient.readable,
      };
    };
    const registration = runAcpProvider({
      id: "sdk-acp",
      label: "SDK ACP",
      connector,
    });

    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());

    await waitForEvent(events, (event) => event.type === "session.ready");
    expect(connection.capabilities).toEqual(["prompt.message"]);
    await connection.close();
  });

  it("maps permission behavior to the first matching ACP option", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "sdk-acp",
      label: "SDK ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "permission"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    const allow = harness.instances[1]!.request("session/request_permission", {
      sessionId: "connector-session",
      toolCall: {
        toolCallId: "tool-allow",
        title: "Allow tool",
        kind: "execute",
        status: "pending",
        content: [],
        rawInput: {},
      },
      options: [
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    await waitForEvent(
      events,
      (event) =>
        event.type === "session.permission" && event.request.id === "permission:tool-allow",
    );
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "permission:tool-allow",
      response: { behavior: "allow" },
    });
    await expect(allow).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });

    const deny = harness.instances[1]!.request("session/request_permission", {
      sessionId: "connector-session",
      toolCall: {
        toolCallId: "tool-deny",
        title: "Deny tool",
        kind: "execute",
        status: "pending",
        content: [],
        rawInput: {},
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
      ],
    });
    await waitForEvent(
      events,
      (event) => event.type === "session.permission" && event.request.id === "permission:tool-deny",
    );
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "permission:tool-deny",
      response: { behavior: "deny" },
    });
    await expect(deny).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-always" },
    });
    await connection.close();
  });

  it("rejects an explicit ACP permission option with the wrong behavior", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "sdk-acp",
      label: "SDK ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "permission"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    const permission = harness.instances[1]!.request("session/request_permission", {
      sessionId: "connector-session",
      toolCall: {
        toolCallId: "tool-explicit",
        title: "Explicit tool",
        kind: "execute",
        status: "pending",
        content: [],
        rawInput: {},
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    await waitForEvent(
      events,
      (event) =>
        event.type === "session.permission" && event.request.id === "permission:tool-explicit",
    );
    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "permission:tool-explicit",
      response: { behavior: "allow", selectedActionId: "missing" },
    });
    await expect(
      waitForEvent(
        events,
        (event) =>
          event.type === "session.runtime_failed" && event.error.message.includes("'missing'"),
      ),
    ).resolves.toBeDefined();

    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "permission:tool-explicit",
      response: { behavior: "allow", selectedActionId: "reject-once" },
    });
    await expect(
      waitForEvent(
        events,
        (event) =>
          event.type === "session.runtime_failed" &&
          event.error.message.includes("'reject-once'") &&
          event.error.message.includes("does not match 'allow' behavior"),
      ),
    ).resolves.toBeDefined();

    await connection.send({
      type: "session.permission",
      sessionId: "session-1",
      permissionId: "permission:tool-explicit",
      response: { behavior: "allow", selectedActionId: "allow-once" },
    });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    await connection.close();
  });

  it("closes both connector directions for the probe and live session", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "owned-acp",
      label: "Owned ACP",
      connector: harness.connector,
    });

    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    expect(harness.instances).toHaveLength(1);

    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    await connection.close();

    expect(harness.instances).toHaveLength(2);
    expect(harness.instances[0]).toMatchObject({ readsCanceled: true, writesClosed: true });
    expect(harness.instances[1]).toMatchObject({ readsCanceled: true, writesClosed: true });
  });

  it("publishes runtime failure on unexpected connector EOF", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "eof-acp",
      label: "EOF ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    harness.instances[1]!.closeFromAgent();

    await expect(
      waitForEvent(events, (event) => event.type === "session.runtime_failed"),
    ).resolves.toMatchObject({
      sessionId: "session-1",
      error: { message: expect.stringContaining("closed") },
    });
    await connection.close();
  });

  it("settles an active auto prompt before admitting its auto replacement", async () => {
    const order: string[] = [];
    let firstPrompt: AcpRequestMessage | null = null;
    let activePrompts = 0;
    let maximumActivePrompts = 0;
    const harness = connectorHarness({
      handleMessage(instance, message) {
        if (!("method" in message)) return false;
        const request = "id" in message ? (message as AcpRequestMessage) : null;
        if (message.method === "session/prompt" && request) {
          const promptNumber = firstPrompt ? "second" : "first";
          order.push(`prompt:${promptNumber}`);
          activePrompts += 1;
          maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts);
          if (!firstPrompt) {
            firstPrompt = request;
          } else {
            activePrompts -= 1;
            instance.respond(request, { stopReason: "end_turn" });
          }
          return true;
        }
        if (message.method === "session/cancel") {
          order.push("cancel");
          activePrompts -= 1;
          instance.respond(firstPrompt!, { stopReason: "cancelled" });
          return true;
        }
        return false;
      },
    });
    const registration = runAcpProvider({
      id: "overlap-acp",
      label: "Overlap ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "first",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "first" }] },
      },
    });
    await expect.poll(() => countRequests(harness.instances[1]!, "session/prompt")).toBe(1);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "second",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "second" }] },
      },
    });

    await waitForEvent(
      events,
      (event) =>
        event.type === "session.turn" &&
        event.turnId === "acp:second" &&
        event.state === "completed",
    );
    expect(order).toEqual(["prompt:first", "cancel", "prompt:second"]);
    expect(maximumActivePrompts).toBe(1);
    const firstTerminal = events.findIndex(
      (event) =>
        event.type === "session.turn" && event.turnId === "acp:first" && event.state === "canceled",
    );
    const secondAdmission = events.findIndex(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "second",
    );
    expect(firstTerminal).toBeGreaterThan(-1);
    expect(firstTerminal).toBeLessThan(secondAdmission);
    await connection.close();
  });

  it.each([
    ["end_turn", "completed", "completed"],
    ["cancelled", "canceled", "canceled"],
  ] as const)(
    "closes a transformer's running tool row when the turn ends with %s",
    async (stopReason, turnState, rowStatus) => {
      const harness = connectorHarness({
        handleMessage(instance, message) {
          if (!("method" in message) || !("id" in message)) return false;
          if (message.method !== "session/prompt") return false;
          instance.notify("vendor/phase", { id: "phase-1", label: "Preparing" });
          instance.respond(message as AcpRequestMessage, { stopReason });
          return true;
        },
      });
      const registration = runAcpProvider({
        id: "vendor-row-acp",
        label: "Vendor row ACP",
        connector: harness.connector,
        transformers: [
          {
            notification(notification) {
              if (notification.method !== "vendor/phase") return null;
              return {
                type: "timeline",
                item: {
                  type: "tool_call",
                  id: "phase-1",
                  callId: "phase-1",
                  name: "Vendor phase",
                  detail: { type: "plain_text", label: "Preparing" },
                  status: "running",
                  error: null,
                },
              };
            },
          },
        ],
      });
      const connection = await registration.connect({
        versions: [1],
        capabilities: ["prompt.message"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "first",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "first" }] },
        },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === turnState,
      );

      const rows = events.flatMap((event) =>
        event.type === "timeline.item" && event.item.id === "phase-1" ? [event.item] : [],
      );
      expect(rows.map((row) => row.type === "tool_call" && row.status)).toEqual([
        "running",
        rowStatus,
      ]);
      const closed = events.findIndex(
        (event) =>
          event.type === "timeline.item" &&
          event.item.id === "phase-1" &&
          event.item.type === "tool_call" &&
          event.item.status === rowStatus,
      );
      const terminal = events.findIndex(
        (event) => event.type === "session.turn" && event.state === turnState,
      );
      expect(closed).toBeLessThan(terminal);
      // The wire contract only accepts a failed tool call with a non-null error.
      expect(rows.at(-1)).toMatchObject({ error: null });
      await connection.close();
    },
  );

  it("cancels an in-progress ACP tool call with the canceled turn instead of failing it without an error", async () => {
    const harness = connectorHarness({
      handleMessage(instance, message) {
        if (!("method" in message) || !("id" in message)) return false;
        if (message.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Run tests",
            kind: "execute",
            status: "in_progress",
          },
        });
        instance.respond(message as AcpRequestMessage, { stopReason: "cancelled" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "cancel-tool-acp",
      label: "Cancel tool ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "first",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "first" }] },
      },
    });
    await waitForEvent(
      events,
      (event) => event.type === "session.turn" && event.state === "canceled",
    );

    const rows = events.flatMap((event) =>
      event.type === "timeline.item" && event.item.id === "tool-1" ? [event.item] : [],
    );
    expect(rows.at(-1)).toMatchObject({ type: "tool_call", status: "canceled", error: null });
    await connection.close();
  });

  it.each([
    { counts: null, context: false, expected: [] },
    {
      counts: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      context: false,
      expected: [
        {
          turnId: "acp:first",
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: undefined },
        },
      ],
    },
    {
      counts: { totalTokens: 18971, inputTokens: 12152, outputTokens: 78, cachedReadTokens: 6741 },
      context: true,
      expected: [
        {
          turnId: undefined,
          usage: { contextWindowUsedTokens: 42, contextWindowMaxTokens: 100, totalCostUsd: 0.25 },
        },
        {
          turnId: "acp:first",
          usage: {
            inputTokens: 12152,
            outputTokens: 78,
            cachedInputTokens: 6741,
            contextWindowUsedTokens: 42,
            contextWindowMaxTokens: 100,
            totalCostUsd: 0.25,
          },
        },
      ],
    },
  ])(
    "forwards prompt-result usage $counts while preserving context updates: $context",
    async ({ counts, context, expected }) => {
      const harness = connectorHarness({
        handleRequest(instance, message) {
          if (message.method !== "session/prompt") return false;
          if (context)
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: {
                sessionUpdate: "usage_update",
                used: 42,
                size: 100,
                cost: { amount: 0.25, currency: "USD" },
              },
            });
          instance.respond(message, {
            stopReason: "end_turn",
            ...(counts ? { usage: counts } : {}),
          });
          return true;
        },
      });
      const registration = runAcpProvider({
        id: "usage-acp",
        label: "Usage ACP",
        connector: harness.connector,
      });
      const connection = await registration.connect({
        versions: [1],
        capabilities: ["prompt.message"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send(openInput());
        await waitForEvent(events, (event) => event.type === "session.ready");
        await connection.send({
          type: "session.prompt",
          sessionId: "session-1",
          prompt: {
            clientMessageId: "first",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "hello" }] },
          },
        });
        await waitForEvent(
          events,
          (event) => event.type === "session.turn" && event.state === "completed",
        );
        const usage = events.flatMap((event) =>
          event.type === "session.usage" ? [{ turnId: event.turnId, usage: event.usage }] : [],
        );
        expect(usage).toEqual(expected);
        const lastUsage = events.findLastIndex((event) => event.type === "session.usage");
        const completed = events.findIndex(
          (event) => event.type === "session.turn" && event.state === "completed",
        );
        expect(lastUsage).toBeLessThan(completed);
      } finally {
        await connection.close();
      }
    },
  );

  it.each([
    { status: "failed", output: undefined, error: { message: "Tool failed" } },
    { status: "failed", output: null, error: { message: "Tool failed" } },
    {
      status: "failed",
      output: { message: "File not found" },
      error: { message: "File not found" },
    },
    { status: "failed", output: "Permission denied", error: "Permission denied" },
    { status: "completed", output: null, error: null },
  ] as const)(
    "keeps a $status ACP tool with output $output valid on the history wire",
    async ({ status, output, error }) => {
      const harness = connectorHarness({
        promptUpdates: () => [
          {
            sessionUpdate: "tool_call",
            toolCallId: "read-1",
            title: "Read file",
            kind: "read",
            status: "in_progress",
          },
          { sessionUpdate: "tool_call_update", toolCallId: "read-1", status, rawOutput: output },
        ],
      });
      const registration = runAcpProvider({
        id: "tool-history-acp",
        label: "Tool history ACP",
        connector: harness.connector,
      });
      const connection = await registration.connect({
        versions: [1],
        capabilities: ["prompt.message"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      try {
        await connection.send(openInput());
        await waitForEvent(events, (event) => event.type === "session.ready");
        await connection.send({
          type: "session.prompt",
          sessionId: "session-1",
          prompt: {
            clientMessageId: "first",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Read a file" }] },
          },
        });
        await waitForEvent(
          events,
          (event) => event.type === "session.turn" && event.state === "completed",
        );
        const rows = events.flatMap((event) =>
          event.type === "timeline.item" && event.item.id === "read-1" ? [event.item] : [],
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(AgentTimelineItemPayloadSchema.safeParse(row).success).toBe(true);
        }
        expect(rows.at(-1)).toMatchObject({ type: "tool_call", status, error });
      } finally {
        await connection.close();
      }
    },
  );

  it("serializes configuration mutations", async () => {
    let releaseMutation: (() => void) | null = null;
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "a",
        options: [
          { name: "A", value: "a" },
          { name: "B", value: "b" },
        ],
      },
    ];
    const harness = connectorHarness({
      capabilities: { loadSession: true },
      configOptions,
      handleRequest(instance, request) {
        if (request.method !== "session/set_config_option") return false;
        const value = (request.params as { value: string }).value;
        if (value !== "first") return false;
        releaseMutation = () =>
          instance.respond(request, {
            configOptions: configOptions.map((option) =>
              Object.assign({}, option, { currentValue: value }),
            ),
          });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "lane-acp",
      label: "Lane ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.configure"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.configure",
      requestId: "configure-first",
      sessionId: "session-1",
      changes: { model: "first" },
    });
    await connection.send({
      type: "session.configure",
      requestId: "configure-second",
      sessionId: "session-1",
      changes: { model: "second" },
    });
    await expect
      .poll(() => countRequests(harness.instances[1]!, "session/set_config_option"))
      .toBe(1);
    releaseMutation!();
    await waitForEvent(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-second",
    );
    expect(
      events
        .filter(
          (event) => event.type === "request.completed" && event.requestId.startsWith("configure-"),
        )
        .map((event) => (event as Extract<ProviderEvent, { type: "request.completed" }>).requestId),
    ).toEqual(["configure-first", "configure-second"]);

    await connection.close();
  });

  it("does not claim exact permission policy, listing, image, or configuration support", async () => {
    const executable = await fakeAcp(basicAgent);
    const { connection, events } = await connect(executable, [
      "prompt.message",
      "prompt.image",
      "session.configure",
      "session.list",
      "permission.tool_policy",
    ]);

    expect(connection.capabilities).toEqual(["prompt.message", "session.configure"]);
    await connection.send(openInput());
    const opened = await waitForEvent(events, (event) => event.type === "session.opened");
    expect(opened).toMatchObject({ capabilities: ["prompt.message"] });
    await waitForEvent(events, (event) => event.type === "session.ready");
    await expect(
      connection.send({
        type: "session.configure",
        requestId: "configure-unsupported",
        sessionId: "session-1",
        changes: { model: "not-advertised" },
      }),
    ).rejects.toThrow("session.configure");
    await connection.close();
  });

  it("derives optional connection capabilities from ACP initialization", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: message.params.protocolVersion,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { list: {} },
    },
  } });
});`);
    const { connection } = await connect(executable, [
      "prompt.message",
      "prompt.image",
      "session.list",
      "session.persistence",
    ]);

    expect(connection.capabilities).toEqual([
      "prompt.message",
      "prompt.image",
      "session.list",
      "session.persistence",
    ]);
    await connection.close();
  });

  it("acknowledges admission before session creation completes", async () => {
    const executable = await fakeAcp(basicAgent);
    const { connection, events } = await connect(executable, ["prompt.message"]);
    let ready = false;
    const admission = connection.send(openInput()).then(() => {
      ready = true;
      return undefined;
    });

    await admission;
    expect(ready).toBe(true);
    expect(events).toEqual([]);
    await waitForEvent(events, (event) => event.type === "session.ready");
    await connection.close();
  });

  it("rejects provider inputs after the ACP connection closes", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "closed-acp",
      label: "Closed ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({ versions: [1], capabilities: [] });

    await connection.close();
    await expect(connection.send({ type: "catalog", requestId: "too-late" })).rejects.toThrow(
      "ACP provider connection is closed",
    );
    expect(harness.instances).toHaveLength(1);
  });

  it("waits for delayed session creation and closes its connector after connection close", async () => {
    let delayedNew: AcpRequestMessage | null = null;
    const harness = connectorHarness({
      handleRequest(_instance, request) {
        if (request.method !== "session/new") return false;
        delayedNew = request;
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "delayed-open-acp",
      label: "Delayed open ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await expect.poll(() => delayedNew).not.toBeNull();

    let closeSettled = false;
    const closing = connection.close().then(() => {
      closeSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    harness.instances[1]!.respond(delayedNew!, {
      sessionId: "late-session",
      modes: null,
      configOptions: [],
    });
    await closing;

    expect(harness.instances[1]).toMatchObject({ readsCanceled: true, writesClosed: true });
    expect(events).toEqual([]);
  });

  it("refuses unsupported steering before sending an ACP prompt", async () => {
    const executable = await fakeAcp(basicAgent);
    const { connection, events } = await connect(executable, ["prompt.message"]);
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    await expect(
      connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-1",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "change course" }] },
        },
      }),
    ).rejects.toThrow("prompt.steer");
    expect(events.some((event) => event.type === "session.prompt_result")).toBe(false);
    await connection.close();
  });

  it("keeps configuration observable state atomic when a later field fails", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let model = "a";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ name: "A", value: "a" }, { name: "B", value: "b" }] },
  { id: "verbosity", name: "Verbosity", type: "select", currentValue: "quiet", options: [{ name: "Quiet", value: "quiet" }, { name: "Loud", value: "loud" }] },
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: options() } });
  else if (message.method === "session/set_config_option" && message.params.configId === "verbosity") send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "verbosity rejected" } });
  else if (message.method === "session/set_config_option") { model = message.params.value; send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options() } }); }
});`);
    const { connection, events } = await connect(executable, [
      "prompt.message",
      "session.configure",
    ]);
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "session-1",
      changes: { model: "b", settings: { verbosity: "loud" } },
    });
    await waitForEvent(
      events,
      (event) => event.type === "request.failed" && event.requestId === "configure-1",
    );
    const configs = events.filter((event) => event.type === "session.config");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ config: { model: "a" } });
    await connection.close();
  });

  it.each([1, 64])(
    "commits transformer config notifications once and discards them on rollback (%i per response)",
    async (notificationCount) => {
      const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (...messages) => process.stdout.write(messages.map((message) => JSON.stringify(message) + "\\n").join(""));
let model = "a";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ name: "A", value: "a" }, { name: "B", value: "b" }] },
  { id: "late", name: "Late", type: "select", currentValue: "ok", options: [{ name: "Ok", value: "ok" }, { name: "Fail", value: "fail" }] },
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: options() } });
  else if (message.method === "session/set_config_option" && message.params.configId === "late") send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "late rejected" } });
  else if (message.method === "session/set_config_option") {
    model = message.params.value;
    send(
      ...Array.from({ length: ${notificationCount} }, () => ({ jsonrpc: "2.0", method: "vendor/config", params: { model } })),
      { jsonrpc: "2.0", id: message.id, result: { configOptions: options() } },
    );
  }
});`);
      const transformer = {
        notification(notification: { method: string; params: unknown }) {
          if (notification.method !== "vendor/config") return null;
          const params = notification.params as { model: string };
          return {
            type: "config" as const,
            config: {
              model: params.model,
              models: [{ id: params.model, label: `Transformer ${params.model}` }],
              modes: [],
              thinkingOptions: [],
              settings: [],
            },
          };
        },
      };
      const { connection, events } = await connect(
        executable,
        ["prompt.message", "session.configure"],
        [transformer],
      );
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      const initialConfigCount = events.filter((event) => event.type === "session.config").length;

      await connection.send({
        type: "session.configure",
        requestId: "transformer-initial-failure",
        sessionId: "session-1",
        changes: { model: "b", settings: { late: "fail" } },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "request.failed" && event.requestId === "transformer-initial-failure",
      );
      expect(events.filter((event) => event.type === "session.config")).toHaveLength(
        initialConfigCount,
      );

      await connection.send({
        type: "session.configure",
        requestId: "transformer-success",
        sessionId: "session-1",
        changes: { model: "b" },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "transformer-success",
      );
      let configs = events.filter((event) => event.type === "session.config");
      expect(configs).toHaveLength(initialConfigCount + 1);
      expect(configs.at(-1)).toMatchObject({
        config: { model: "b", models: [{ label: "Transformer b" }] },
      });

      await connection.send({
        type: "session.configure",
        requestId: "transformer-failure",
        sessionId: "session-1",
        changes: { model: "a", settings: { late: "fail" } },
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.failed" && event.requestId === "transformer-failure",
      );
      configs = events.filter((event) => event.type === "session.config");
      expect(configs).toHaveLength(initialConfigCount + 1);
      expect(configs.at(-1)).toMatchObject({ config: { model: "b" } });
      await connection.close();
    },
  );

  it("discovers each model's own thinking options when the agent describes only the selected model", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const levels = (values) => values.map((value) => ({ name: value[0].toUpperCase() + value.slice(1), value }));
const thinking = {
  neon: { currentValue: "high", options: levels(["low", "high", "xhigh"]) },
  carbon: { currentValue: "medium", options: levels(["low", "medium", "high"]) },
};
let model = "neon";
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ name: "Neon", value: "neon" }, { name: "Carbon", value: "carbon" }, { name: "Orchestrator", value: "orchestrator" }] },
  ...(thinking[model] ? [{ id: "thought_level", name: "Thinking", category: "thought_level", type: "select", ...thinking[model] }] : []),
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: options() } });
  else if (message.method === "session/set_config_option") {
    if (message.params.configId === "model") model = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options() } });
  }
});`);
    let modelSeenByTransformer: unknown;
    const registration = runAcpProvider({
      id: "test-acp",
      label: "Test ACP",
      command: [process.execPath, executable],
      acpOptions: { perModelThinkingOptions: true },
      transformers: [
        {
          async discover(catalog, { config }) {
            modelSeenByTransformer = (await config.read()).model;
            return catalog;
          },
        },
      ],
    });
    const connection = await registration.connect({ versions: [1], capabilities: [] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "catalog", requestId: "catalog-1", cwd: process.cwd() });
      const event = await waitForEvent(
        events,
        (candidate) => candidate.type === "catalog" || candidate.type === "request.failed",
      );
      if (event.type !== "catalog") throw new Error(`Expected catalog, got ${event.type}`);
      expect(event.catalog.defaultModel).toBe("neon");
      expect(event.catalog.models.map(modelThinking)).toEqual([
        { id: "neon", thinkingOptions: ["low", "high", "xhigh"], defaultThinkingOptionId: "high" },
        {
          id: "carbon",
          thinkingOptions: ["low", "medium", "high"],
          defaultThinkingOptionId: "medium",
        },
        { id: "orchestrator", thinkingOptions: [], defaultThinkingOptionId: undefined },
      ]);
      expect(modelSeenByTransformer).toBe("neon");
    } finally {
      await connection.close();
    }
  });

  it("selects the model control when an agent files several controls under the model category", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let model = "small";
const modes = { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }, { id: "ask", name: "Ask" }] };
const options = () => [
  { id: "provider", name: "Provider", category: "model", type: "select", currentValue: "gateway", options: [{ name: "Gateway", value: "gateway" }, { name: "Local", value: "local" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: [{ name: "Small", value: "small" }, { name: "Large", value: "large" }] },
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "auto", options: [{ name: "Auto", value: "auto" }, { name: "Ask", value: "ask" }] },
  { id: "fast", name: "Fast Mode", category: "model", type: "select", currentValue: "false", options: [{ name: "Off", value: "false" }, { name: "On", value: "true" }] },
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes, configOptions: options() } });
  else if (message.method === "session/set_config_option") {
    if (message.params.configId === "model") model = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options() } });
  }
});`);
    const { connection, events } = await connect(executable, [
      "prompt.message",
      "session.configure",
    ]);
    await connection.send({ type: "catalog", requestId: "catalog-1" });
    await waitForEvent(events, (event) => event.type === "catalog");
    expect(events.find((event) => event.type === "catalog")).toMatchObject({
      catalog: {
        defaultModel: "small",
        models: [
          { id: "small", label: "Small" },
          { id: "large", label: "Large" },
        ],
      },
    });

    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "session-1",
      changes: { model: "large" },
    });
    await waitForEvent(
      events,
      (event) => event.type === "request.completed" && event.requestId === "configure-1",
    );
    const config = events.findLast((event) => event.type === "session.config");
    expect(config).toMatchObject({ config: { model: "large" } });
    if (config?.type !== "session.config") throw new Error("Expected session.config");
    expect(config.config.settings?.map((setting) => setting.id)).toEqual(["provider", "fast"]);
    await connection.close();
  });

  it("applies opening configuration in the order the agent lists its options", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let provider = "first";
let model = "first-saved";
const saved = { first: "first-saved", second: "second-saved" };
const select = (id, currentValue, values) => ({ id, name: id, category: "model", type: "select", currentValue, options: values.map((value) => ({ name: value, value })) });
const options = () => [
  select("provider", provider, ["first", "second"]),
  select("model", model, ["first-saved", "second-saved", "second-chosen"]),
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", configOptions: options() } });
  else if (message.method === "session/set_config_option") {
    if (message.params.configId === "provider") { provider = message.params.value; model = saved[provider]; }
    if (message.params.configId === "model") model = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options() } });
  }
});`);
    const { connection, events } = await connect(executable, [
      "prompt.message",
      "session.configure",
    ]);
    const input = openInput({ provider: "second" });

    await connection.send({ ...input, config: { ...input.config, model: "second-chosen" } });

    await waitForEvent(events, (event) => event.type === "session.ready");
    expect(events.findLast((event) => event.type === "session.config")).toMatchObject({
      config: { model: "second-chosen" },
    });
    await connection.close();
  });

  it("gives discovery transformers the discovered session configuration facade", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "catalog-native", modes: null, configOptions: [{ id: "flavor", name: "Flavor", type: "select", currentValue: "mint", options: [{ name: "Mint", value: "mint" }] }] } });
});`);
    let discovered: Readonly<Record<string, unknown>> | null = null;
    const { connection, events } = await connect(
      executable,
      [],
      [
        {
          async discover(catalog, context) {
            discovered = await context.config.read();
            return catalog;
          },
        },
      ],
    );

    await connection.send({ type: "catalog", requestId: "catalog-1" });
    await waitForEvent(events, (event) => event.type === "catalog");
    expect(discovered).toEqual({ flavor: "mint" });
    await connection.close();
  });

  it("drains heavy ACP stderr while initializing", async () => {
    const executable = await fakeAcp(
      `process.stderr.write("x".repeat(2 * 1024 * 1024));\n${basicAgent}`,
    );
    const { connection, events } = await connect(executable, ["prompt.message"]);
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    await connection.close();
  });

  it("publishes runtime failure when the ACP process dies", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
    setTimeout(() => process.exit(17), 20);
  }
});`);
    const { connection, events } = await connect(executable, ["prompt.message"]);
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    const failure = await waitForEvent(events, (event) => event.type === "session.runtime_failed");
    expect(failure).toMatchObject({
      sessionId: "session-1",
      error: { message: expect.stringContaining("17") },
    });
    await connection.close();
  });

  it("escalates shutdown when an ACP process ignores SIGTERM", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
process.on("SIGTERM", () => {});
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
});`);
    const { connection, events } = await connect(executable, ["prompt.message"]);
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    const startedAt = Date.now();
    await connection.close();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
});

async function hangingCatalogAgent(): Promise<{ executable: string; catalogCwd: string }> {
  const catalogCwd = await mkdtemp(path.join(tmpdir(), "paseo-acp-hanging-catalog-"));
  temporaryDirectories.push(catalogCwd);
  // The catalogue probe records its PID and stays resident like an agent that ignores EOF.
  const executable = await fakeAcp(`const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const catalogCwd = ${JSON.stringify(catalogCwd)};
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new" && message.params.cwd === catalogCwd) {
    setInterval(() => undefined, 1_000);
    fs.writeFileSync(path.join(catalogCwd, "probe.pid"), String(process.pid));
  }
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
  else if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});`);
  return { executable, catalogCwd };
}

function readIfPresent(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function probePid(catalogCwd: string): Promise<number> {
  const file = path.join(catalogCwd, "probe.pid");
  await expect.poll(() => readIfPresent(file), { timeout: 5_000 }).not.toBe("");
  return Number(await readFile(file, "utf8"));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("runAcpProvider catalogue requests whose session/new never answers", () => {
  it("offers request cancellation", async () => {
    const { executable } = await hangingCatalogAgent();
    const { connection } = await connect(executable, ["prompt.message", "request.cancel"]);
    try {
      expect(connection.capabilities).toContain("request.cancel");
    } finally {
      await connection.close();
    }
  });

  it("stops the probe process when Paseo cancels the request and keeps open sessions running", async () => {
    const { executable, catalogCwd } = await hangingCatalogAgent();
    const { connection, events } = await connect(executable, ["prompt.message", "request.cancel"]);
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");

      await connection.send({ type: "catalog", requestId: "catalog-1", cwd: catalogCwd });
      const pid = await probePid(catalogCwd);
      expect(isRunning(pid)).toBe(true);

      await connection.send({ type: "request.cancel", requestId: "catalog-1" });
      await expect.poll(() => isRunning(pid), { timeout: 3_000 }).toBe(false);

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "after-cancel",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "still there?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "completed",
      );
      expect(
        events.filter((event) => "requestId" in event && event.requestId === "catalog-1"),
      ).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("publishes the catalogue before the probe session starts closing", async () => {
    const closeMarker = path.join(
      await mkdtemp(path.join(tmpdir(), "paseo-acp-catalog-close-")),
      "close-started",
    );
    temporaryDirectories.push(path.dirname(closeMarker));
    // session/close never answers, so the probe's shutdown runs into its close timeout.
    const executable = await fakeAcp(`const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "catalog-native", modes: null, configOptions: [] } });
  else if (message.method === "session/close") fs.writeFileSync(${JSON.stringify(closeMarker)}, "started");
});`);
    const { connection, events } = await connect(executable, ["prompt.message", "request.cancel"]);
    let closingWhenPublished: boolean | undefined;
    connection.onEvent((event) => {
      if (event.type === "catalog") closingWhenPublished = existsSync(closeMarker);
    });
    try {
      await connection.send({ type: "catalog", requestId: "catalog-1" });
      await waitForEvent(events, (event) => event.type === "catalog");
      expect(closingWhenPublished).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("ignores cancellation of a request that already finished", async () => {
    const executable = await fakeAcp(basicAgent);
    const { connection, events } = await connect(executable, ["prompt.message", "request.cancel"]);
    try {
      await connection.send({ type: "catalog", requestId: "catalog-1" });
      await waitForEvent(events, (event) => event.type === "catalog");
      await expect(
        connection.send({ type: "request.cancel", requestId: "catalog-1" }),
      ).resolves.toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it("stops the probe process when the connection closes", async () => {
    const { executable, catalogCwd } = await hangingCatalogAgent();
    const { connection } = await connect(executable, ["prompt.message", "request.cancel"]);
    await connection.send({ type: "catalog", requestId: "catalog-1", cwd: catalogCwd });
    const pid = await probePid(catalogCwd);

    await connection.close();
    expect(isRunning(pid)).toBe(false);
  });
});

describe("runAcpProvider streamed chunks without messageId (#4699)", () => {
  interface Chunk {
    kind: "agent_message_chunk" | "agent_thought_chunk";
    text: string;
    messageId?: string;
  }

  it("continues one timeline item per turn instead of one per chunk", async () => {
    const chunksByPrompt: Record<string, Chunk[]> = {
      first: [
        { kind: "agent_message_chunk", text: "- **Current tem" },
        { kind: "agent_message_chunk", text: "perature**: 25°C" },
      ],
      second: [{ kind: "agent_message_chunk", text: "next turn" }],
      // An explicit-id text chunk between two id-less thoughts separates them.
      third: [
        { kind: "agent_thought_chunk", text: "think A" },
        { kind: "agent_message_chunk", text: "say", messageId: "m-explicit" },
        { kind: "agent_thought_chunk", text: "think B" },
      ],
    };
    const harness = connectorHarness({
      promptUpdates: (promptText) =>
        (chunksByPrompt[promptText] ?? []).map((chunk) => {
          const update: Record<string, unknown> = {
            sessionUpdate: chunk.kind,
            content: { type: "text", text: chunk.text },
          };
          if (chunk.messageId) update.messageId = chunk.messageId;
          return update;
        }),
    });
    const registration = runAcpProvider({
      id: "chunk-acp",
      label: "Chunk ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");

    for (const clientMessageId of ["first", "second", "third"]) {
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: clientMessageId }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === `acp:${clientMessageId}` &&
          event.state === "completed",
      );
    }

    const items = events.flatMap((event) =>
      event.type === "timeline.item" &&
      (event.item.type === "assistant_message" || event.item.type === "reasoning")
        ? [
            {
              id: event.item.id,
              text: event.item.text,
              ...(event.item.type === "assistant_message" && event.item.messageId
                ? { messageId: event.item.messageId }
                : {}),
            },
          ]
        : [],
    );
    expect(items).toEqual([
      { id: "agent_message_chunk:1", text: "- **Current tem" },
      { id: "agent_message_chunk:1", text: "- **Current temperature**: 25°C" },
      { id: "agent_message_chunk:2", text: "next turn" },
      { id: "agent_thought_chunk:3", text: "think A" },
      {
        id: JSON.stringify(["agent_message_chunk", "m-explicit"]),
        messageId: "m-explicit",
        text: "say",
      },
      { id: "agent_thought_chunk:4", text: "think B" },
    ]);
    await connection.close();
  });
});

function textChunk(
  text: string,
  kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
  messageId?: string,
): SessionUpdate {
  return {
    sessionUpdate: kind,
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

async function streamChunkTurns(
  updates: SessionUpdate[],
  ending: "completed" | "canceled" | "failed" = "completed",
) {
  let promptCount = 0;
  const harness = connectorHarness({
    handleRequest(instance, request) {
      if (request.method !== "session/prompt") return false;
      promptCount++;
      for (const update of promptCount === 1 ? updates : [textChunk("Next turn")]) {
        instance.notify("session/update", { sessionId: "connector-session", update });
      }
      if (promptCount === 1 && ending === "failed") instance.reject(request, "Prompt failed");
      else
        instance.respond(request, {
          stopReason: promptCount === 1 && ending === "canceled" ? "cancelled" : "end_turn",
        });
      return true;
    },
  });
  const registration = runAcpProvider({
    id: "chunk-boundaries",
    label: "Chunk boundaries",
    connector: harness.connector,
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    for (const clientMessageId of ["first", "second"]) {
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: clientMessageId }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === `acp:${clientMessageId}` &&
          event.state === (clientMessageId === "first" ? ending : "completed"),
      );
    }
    const messages = new Map<string, { type: string; text: string }>();
    for (const event of events) {
      if (
        event.type === "timeline.item" &&
        (event.item.type === "assistant_message" || event.item.type === "reasoning")
      ) {
        messages.set(event.item.id, { type: event.item.type, text: event.item.text });
      }
    }
    return [...messages.values()];
  } finally {
    await connection.close();
  }
}

describe("ACP streamed message boundaries", () => {
  it("keeps reasoning separate from a reply sharing its native message ID", async () => {
    expect(
      await streamChunkTurns([
        textChunk("private ", "agent_thought_chunk", "shared-id"),
        textChunk("reasoning", "agent_thought_chunk", "shared-id"),
        textChunk("public ", "agent_message_chunk", "shared-id"),
        textChunk("reply", "agent_message_chunk", "shared-id"),
      ]),
    ).toEqual([
      { type: "reasoning", text: "private reasoning" },
      { type: "assistant_message", text: "public reply" },
      { type: "assistant_message", text: "Next turn" },
    ]);
  });

  it.each([
    {
      name: "tool call",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool",
        title: "Read",
        kind: "read",
        status: "in_progress",
      },
    },
    { name: "plan", update: { sessionUpdate: "plan", entries: [] } },
    {
      name: "user message",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "User" } },
    },
  ] satisfies Array<{ name: string; update: SessionUpdate }>)(
    "starts a new message after a $name",
    async ({ update }) => {
      expect(
        await streamChunkTurns([
          textChunk("Before"),
          update,
          textChunk("After "),
          textChunk("boundary"),
        ]),
      ).toEqual([
        { type: "assistant_message", text: "Before" },
        { type: "assistant_message", text: "After boundary" },
        { type: "assistant_message", text: "Next turn" },
      ]);
    },
  );

  it("continues text while an existing tool receives a status update", async () => {
    expect(
      await streamChunkTurns([
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool",
          title: "Read",
          kind: "read",
          status: "in_progress",
        },
        textChunk("Still "),
        { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" },
        textChunk("speaking"),
      ]),
    ).toEqual([
      { type: "assistant_message", text: "Still speaking" },
      { type: "assistant_message", text: "Next turn" },
    ]);
  });

  it("keeps explicit messages separate from neighboring anonymous chunks", async () => {
    expect(
      await streamChunkTurns([
        textChunk("Before"),
        textChunk("Explicit ", "agent_message_chunk", "message"),
        textChunk("message", "agent_message_chunk", "message"),
        textChunk("After"),
      ]),
    ).toEqual([
      { type: "assistant_message", text: "Before" },
      { type: "assistant_message", text: "Explicit message" },
      { type: "assistant_message", text: "After" },
      { type: "assistant_message", text: "Next turn" },
    ]);
  });

  it("continues reasoning but starts a new segment after nontext assistant content", async () => {
    expect(
      await streamChunkTurns([
        textChunk("Think ", "agent_thought_chunk"),
        textChunk("first", "agent_thought_chunk"),
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "", mimeType: "image/png" },
        },
        textChunk("Then think", "agent_thought_chunk"),
      ]),
    ).toEqual([
      { type: "reasoning", text: "Think first" },
      { type: "reasoning", text: "Then think" },
      { type: "assistant_message", text: "Next turn" },
    ]);
  });

  it.each(["completed", "canceled", "failed"] as const)(
    "keeps the next turn separate after a %s prompt",
    async (ending) => {
      expect(await streamChunkTurns([textChunk("First "), textChunk("turn")], ending)).toEqual([
        { type: "assistant_message", text: "First turn" },
        { type: "assistant_message", text: "Next turn" },
      ]);
    },
  );
});

function userChunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  };
}

async function openReplaySession(
  replay: SessionUpdate[],
  history: "replay" | "skip",
): Promise<{ connection: ProviderConnection; events: ProviderEvent[] }> {
  const harness = connectorHarness({
    capabilities: { loadSession: true },
    handleRequest(instance, request) {
      if (request.method !== "session/load") return false;
      for (const update of replay) {
        instance.notify("session/update", { sessionId: "connector-session", update });
      }
      instance.respond(request, {
        sessionId: "connector-session",
        modes: null,
        configOptions: [],
      });
      return true;
    },
  });
  const registration = runAcpProvider({
    id: "replay-acp",
    label: "Replay ACP",
    connector: harness.connector,
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const input = openInput();
  input.persistence = { version: 1, data: { sessionId: "connector-session" } };
  input.history = history;
  await connection.send(input);
  await waitForEvent(events, (event) => event.type === "session.ready");
  return { connection, events };
}

function timelineProjection(events: ProviderEvent[]): Array<Record<string, string>> {
  return events.flatMap((event) => {
    if (event.type !== "timeline.item") return [];
    const item = event.item;
    if (
      item.type === "user_message" ||
      item.type === "assistant_message" ||
      item.type === "reasoning"
    ) {
      return [{ type: item.type, id: item.id, text: item.text }];
    }
    if (item.type === "tool_call") return [{ type: item.type, id: item.id, status: item.status }];
    return [{ type: item.type, id: item.id }];
  });
}

describe("ACP session history replay", () => {
  it("restores the timeline replayed before session/load resolves", async () => {
    const { connection, events } = await openReplaySession(
      [
        userChunk("What is the ", "user-1"),
        userChunk("temperature?", "user-1"),
        textChunk("Checking the sensor", "agent_thought_chunk"),
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read sensor",
          kind: "read",
          status: "in_progress",
        },
        { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
        textChunk("It is 25°C"),
      ],
      "replay",
    );
    try {
      expect(timelineProjection(events)).toEqual([
        { type: "user_message", id: '["user_message_chunk","user-1"]', text: "What is the " },
        {
          type: "user_message",
          id: '["user_message_chunk","user-1"]',
          text: "What is the temperature?",
        },
        { type: "reasoning", id: "agent_thought_chunk:1", text: "Checking the sensor" },
        { type: "tool_call", id: "tool-1", status: "running" },
        { type: "tool_call", id: "tool-1", status: "completed" },
        { type: "assistant_message", id: "agent_message_chunk:2", text: "It is 25°C" },
      ]);
      const lastReplayed = events.findLastIndex((event) => event.type === "timeline.item");
      const opened = events.findIndex((event) => event.type === "session.opened");
      expect(lastReplayed).toBeLessThan(opened);
    } finally {
      await connection.close();
    }
  });

  it("keeps replayed user, reasoning and reply chunks separate when their native IDs match", async () => {
    const { connection, events } = await openReplaySession(
      [
        userChunk("What is the ", "shared-id"),
        userChunk("temperature?", "shared-id"),
        textChunk("Checking ", "agent_thought_chunk", "shared-id"),
        textChunk("the sensor", "agent_thought_chunk", "shared-id"),
        textChunk("It is ", "agent_message_chunk", "shared-id"),
        textChunk("25°C", "agent_message_chunk", "shared-id"),
      ],
      "replay",
    );
    try {
      const items = new Map(
        events.flatMap((event) =>
          event.type === "timeline.item" ? [[event.item.id, event.item] as const] : [],
        ),
      );
      expect([...items.values()]).toEqual([
        {
          type: "user_message",
          id: '["user_message_chunk","shared-id"]',
          messageId: "shared-id",
          text: "What is the temperature?",
        },
        {
          type: "reasoning",
          id: '["agent_thought_chunk","shared-id"]',
          text: "Checking the sensor",
        },
        {
          type: "assistant_message",
          id: '["agent_message_chunk","shared-id"]',
          messageId: "shared-id",
          text: "It is 25°C",
        },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("continues anonymous user chunks into one message and starts a new one after an agent reply", async () => {
    const { connection, events } = await openReplaySession(
      [
        userChunk("first "),
        userChunk("question"),
        textChunk("answer"),
        userChunk("second question"),
      ],
      "replay",
    );
    try {
      expect(timelineProjection(events)).toEqual([
        { type: "user_message", id: "user_message_chunk:1", text: "first " },
        { type: "user_message", id: "user_message_chunk:1", text: "first question" },
        { type: "assistant_message", id: "agent_message_chunk:2", text: "answer" },
        { type: "user_message", id: "user_message_chunk:3", text: "second question" },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("does not duplicate the live prompt echo when the agent echoes it as a user chunk", async () => {
    const harness = connectorHarness({
      capabilities: { loadSession: true },
      promptUpdates: (promptText) => [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: promptText } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Acknowledged" } },
      ],
    });
    const registration = runAcpProvider({
      id: "echo-acp",
      label: "Echo ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    const input = openInput();
    input.persistence = { version: 1, data: { sessionId: "connector-session" } };
    input.history = "replay";
    await connection.send(input);
    await waitForEvent(events, (event) => event.type === "session.ready");

    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "echo-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    try {
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:echo-1" &&
          event.state === "completed",
      );
      expect(timelineProjection(events)).toEqual([
        { type: "user_message", id: "echo-1", text: "hello" },
        { type: "assistant_message", id: "agent_message_chunk:1", text: "Acknowledged" },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("drops replayed updates when the open request asks to skip history", async () => {
    const { connection, events } = await openReplaySession(
      [userChunk("What is in the README?", "user-1"), textChunk("It describes the project.")],
      "skip",
    );
    try {
      expect(timelineProjection(events)).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});

it("sends extension requests from discovery and configure and preserves JSON-RPC errors", async () => {
  const { connector, instances } = connectorHarness({
    handleRequest(instance, request) {
      if (request.method === "_example/catalog") {
        instance.respond(request, { model: "vendor-model" });
        return true;
      }
      if (request.method === "_example/select") {
        instance.reject(request, "Vendor rejected the selection");
        return true;
      }
      return false;
    },
  });
  const registration = runAcpProvider({
    id: "extensions",
    label: "Extensions",
    connector,
    transformers: [
      {
        async discover(catalog, { request }) {
          expect(await request("_example/catalog", { scope: "all" })).toEqual({
            model: "vendor-model",
          });
          return { ...catalog, defaultModel: "vendor-model" };
        },
        async configure(change, { request }) {
          await expect(request("_example/select", { model: change.value })).rejects.toMatchObject({
            code: -32603,
            message: "Vendor rejected the selection",
          });
          return "handled";
        },
      },
    ],
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["session.configure"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({ type: "catalog", requestId: "catalog" });
    expect(
      await waitForEvent(
        events,
        (event) => event.type === "catalog" || event.type === "request.failed",
      ),
    ).toMatchObject({ type: "catalog", catalog: { defaultModel: "vendor-model" } });
    expect(instances[0].requests).toContainEqual(
      expect.objectContaining({
        method: "_example/catalog",
        params: { scope: "all" },
      }),
    );

    const input = openInput();
    await connection.send({ ...input, config: { ...input.config, model: "vendor-model" } });
    expect(
      await waitForEvent(
        events,
        (event) => event.type === "session.ready" || event.type === "request.failed",
      ),
    ).toMatchObject({ type: "session.ready" });
    expect(instances[1].requests).toContainEqual(
      expect.objectContaining({
        method: "_example/select",
        params: { model: "vendor-model" },
      }),
    );
  } finally {
    await connection.close();
  }
});

it("rewrites the session-ready, notification and configure-commit config snapshots", async () => {
  const modelOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "first",
    options: ["first", "second", "third"].map((value) => ({ name: value, value })),
  };
  const { connector, instances } = connectorHarness({ configOptions: [modelOption] });
  const registration = runAcpProvider({
    id: "config-transformer",
    label: "Config Transformer",
    connector,
    transformers: [
      {
        config(state, { sessionId }) {
          return { ...state, model: `${sessionId}/${state.model}` };
        },
      },
    ],
  });
  const connection = await registration.connect({
    versions: [1],
    capabilities: ["session.configure"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const models = () =>
    events.flatMap((event) => (event.type === "session.config" ? [event.config.model] : []));
  try {
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    expect(models()).toEqual(["session-1/first"]);

    instances[1].notify("session/update", {
      sessionId: "connector-session",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ ...modelOption, currentValue: "second" }],
      },
    });
    await expect.poll(models).toEqual(["session-1/first", "session-1/second"]);

    await connection.send({
      type: "session.configure",
      requestId: "configure",
      sessionId: "session-1",
      changes: { model: "third" },
    });
    await expect.poll(models).toEqual(["session-1/first", "session-1/second", "session-1/third"]);
  } finally {
    await connection.close();
  }
});

describe("deferTurnOnRunningTools", () => {
  it("keeps the turn open across end_turn until a running tool completes and the reply settles", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cmd-1",
            name: "run_command",
            title: "Run background job",
            status: "in_progress",
            rawInput: { CommandLine: "sleep 10" },
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Started in background."),
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-turn",
      label: "Deferred Turn",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "turn-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "cmd-1" &&
          event.item.status === "running",
      );
      // Give end_turn time to drain; the turn must remain open while cmd-1 is in_progress.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:turn-1" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Tool completes, followed by a usage_update before any assistant text: must NOT settle yet.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "cmd-1",
          status: "completed",
          rawOutput: { stdout: "DONE" },
        },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 150, size: 1000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:turn-1" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Model emits follow-up reply and usage_update: turn settles after settleDelayMs.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Background job finished: DONE."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 200, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:turn-1" &&
          event.state === "completed",
      );
      expect(
        events.filter((event) => event.type === "session.turn").map((event) => event.state),
      ).toEqual(["started", "completed"]);
    } finally {
      await connection.close();
    }
  });

  it("does not defer when keepsTurnOpen excludes the running tool", async () => {
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "daemon-1",
            name: "run_command",
            title: "Start dev server",
            status: "in_progress",
            rawInput: { CommandLine: "npm run dev", IsDaemon: true },
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-daemon",
      label: "Deferred Daemon",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 500,
          keepsTurnOpen(toolCall) {
            const input = toolCall.input;
            return !(
              typeof input === "object" &&
              input !== null &&
              !Array.isArray(input) &&
              input.IsDaemon === true
            );
          },
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "daemon-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start server" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:daemon-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("settles via quietLimitMs when a background tool finishes with no follow-up reply", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "silent-1",
            name: "run_command",
            title: "Silent job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-quiet",
      label: "Deferred Quiet",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 20, quietLimitMs: 50 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "quiet-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run silent" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "silent-1",
      );
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "silent-1", status: "completed" },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:quiet-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("preserves running tools across a follow-up prompt without sending session/cancel", async () => {
    let promptCount = 0;
    let cancelCount = 0;
    const { connector, instances } = connectorHarness({
      handleMessage(_instance, message) {
        if ("method" in message && message.method === "session/cancel") {
          cancelCount += 1;
          return true;
        }
        return false;
      },
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-1",
              name: "run_command",
              title: "Long job",
              status: "in_progress",
            },
          });
        } else {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: textChunk("ACK"),
          });
        }
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-followup",
      label: "Deferred Followup",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "turn-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start long job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-1",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Send a follow-up prompt while bg-1 is still running.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "turn-2",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "ping" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:turn-1" &&
          event.state === "completed",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "ACK",
      );
      // No session/cancel was sent, and turn-2 stays deferred while bg-1 is still running.
      expect(cancelCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:turn-2" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Now bg-1 finishes and the agent replies.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Long job done."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 220, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:turn-2" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("cancels a deferred turn on interrupt and ignores trailing cancellation tool failures", async () => {
    let cancelCount = 0;
    const { connector, instances } = connectorHarness({
      handleMessage(_instance, message) {
        if ("method" in message && message.method === "session/cancel") {
          cancelCount += 1;
          return true;
        }
        return false;
      },
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "cancel-me",
            name: "run_command",
            title: "Cancelable job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-cancel",
      label: "Deferred Cancel",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "cancel-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "cancel-me",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      await connection.send({
        type: "session.interrupt",
        requestId: "stop-1",
        sessionId: "session-1",
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:cancel-turn" &&
          event.state === "canceled",
      );
      await waitForEvent(events, (event) => event.type === "session.closed");
      expect(cancelCount).toBe(1);
      expect(instances[1].readsCanceled).toBe(true);
      const toolEvents = events.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "cancel-me",
      );
      expect(toolEvents.at(-1)).toMatchObject({
        type: "timeline.item",
        item: { id: "cancel-me", status: "canceled" },
      });
    } finally {
      await connection.close();
    }
  });

  it("fails a deferred turn cleanly when the transport closes unexpectedly", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "crash-1",
            name: "run_command",
            title: "Crashing job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-crash",
      label: "Deferred Crash",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "crash-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "crash-1",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      instances[1].closeFromAgent();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:crash-turn" &&
          event.state === "failed",
      );
    } finally {
      await connection.close();
    }
  });

  it("steers a deferred turn without session/cancel and refuses steering while a wire prompt is in flight", async () => {
    let promptCount = 0;
    let cancelCount = 0;
    let holdFirstPrompt: (() => void) | null = null;
    const { connector, instances } = connectorHarness({
      handleMessage(_instance, message) {
        if ("method" in message && message.method === "session/cancel") {
          cancelCount += 1;
          return true;
        }
        return false;
      },
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-steer",
              name: "run_command",
              title: "Long background job",
              status: "in_progress",
            },
          });
          holdFirstPrompt = () => instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Steered ACK"),
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-steer",
      label: "Deferred Steer",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    expect(connection.capabilities).toContain("prompt.steer");
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "turn-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-steer",
      );

      // Steering while the wire prompt is still in flight is rejected so callers can fall back.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-too-early",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "early steer" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "steer-too-early" &&
          event.result.type === "failed",
      );

      // Resolve the wire prompt so the turn enters deferred mode.
      holdFirstPrompt!();
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Steering while deferred succeeds in-turn without sending session/cancel.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-1",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "status?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "steer-1" &&
          event.result.type === "steer" &&
          event.result.turnId === "acp:turn-1",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Steered ACK",
      );
      expect(cancelCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:turn-1" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Background job finishes and replies: the single turn completes cleanly.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-steer", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Job complete."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 300, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:turn-1" &&
          event.state === "completed",
      );
      expect(cancelCount).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it("keeps the turn open if a new qualifying tool arrives as the settle timer expires", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            name: "run_command",
            title: "First job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-race",
      label: "Deferred Race",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "race-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run jobs" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "tool-1",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      // First tool completes and arms the 30ms settle timer.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Starting second job."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
      });

      // Right as the 30ms timer fires, a second qualifying tool starts.
      await new Promise((resolve) => setTimeout(resolve, 28));
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          name: "run_command",
          title: "Second job",
          status: "in_progress",
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "tool-2" &&
          event.item.status === "running",
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:race-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Once tool-2 finishes and the model replies, the turn completes.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-2", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Second job done."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 200, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:race-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("suppresses deferred cancel echoes across a new prompt without filtering opt-out providers", async () => {
    // Part 1: Opt-out provider (no deferTurnOnRunningTools) still receives late tool updates after cancel.
    let optOutPrompt: AcpRequestMessage | null = null;
    const optOut = connectorHarness({
      handleMessage(instance, message) {
        if ("method" in message && message.method === "session/cancel" && optOutPrompt) {
          instance.respond(optOutPrompt, { stopReason: "cancelled" });
          optOutPrompt = null;
          return true;
        }
        return false;
      },
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        optOutPrompt = request;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "optout-tool",
            name: "run_command",
            title: "Opt-out tool",
            status: "in_progress",
          },
        });
        return true;
      },
    });
    const optOutReg = runAcpProvider({
      id: "optout-cancel",
      label: "Opt-out Cancel",
      connector: optOut.connector,
    });
    const optOutConn = await optOutReg.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const optOutEvents: ProviderEvent[] = [];
    optOutConn.onEvent((event) => optOutEvents.push(event));
    try {
      await optOutConn.send(openInput());
      await waitForEvent(optOutEvents, (event) => event.type === "session.ready");
      await optOutConn.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "optout-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "go" }] },
        },
      });
      await waitForEvent(
        optOutEvents,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "optout-tool",
      );
      await optOutConn.send({
        type: "session.interrupt",
        requestId: "optout-stop",
        sessionId: "session-1",
      });
      await waitForEvent(
        optOutEvents,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:optout-1" &&
          event.state === "canceled",
      );
      optOut.instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "optout-tool",
          status: "completed",
          rawOutput: { ok: true },
        },
      });
      await waitForEvent(
        optOutEvents,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "optout-tool" &&
          event.item.status === "completed",
      );
    } finally {
      await optOutConn.close();
    }

    // Part 2: Deferred-canceled tool echo arriving AFTER a new prompt starts is still suppressed.
    let promptNum = 0;
    const deferred = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptNum += 1;
        if (promptNum === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "late-echo",
              name: "run_command",
              title: "Canceled tool",
              status: "in_progress",
            },
          });
        } else {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: textChunk("Second turn"),
          });
        }
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const deferredReg = runAcpProvider({
      id: "deferred-echo",
      label: "Deferred Echo",
      connector: deferred.connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const deferredConn = await deferredReg.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const deferredEvents: ProviderEvent[] = [];
    deferredConn.onEvent((event) => deferredEvents.push(event));
    try {
      await deferredConn.send(openInput());
      await waitForEvent(deferredEvents, (event) => event.type === "session.ready");
      await deferredConn.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "echo-turn-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "first" }] },
        },
      });
      await waitForEvent(
        deferredEvents,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "late-echo",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      await deferredConn.send({
        type: "session.interrupt",
        requestId: "echo-stop",
        sessionId: "session-1",
      });
      await waitForEvent(
        deferredEvents,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:echo-turn-1" &&
          event.state === "canceled",
      );
      await waitForEvent(deferredEvents, (event) => event.type === "session.closed");
      expect(deferred.instances[1].readsCanceled).toBe(true);
      const toolEvents = deferredEvents.filter(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "late-echo",
      );
      expect(toolEvents.at(-1)).toMatchObject({
        type: "timeline.item",
        item: { id: "late-echo", status: "canceled" },
      });
    } finally {
      await deferredConn.close();
    }
  });

  it("does not defer when stopReason is not end_turn", async () => {
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "limit-tool",
            name: "run_command",
            title: "Stopped at limit",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "max_turn_requests" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-stop-reason",
      label: "Deferred Stop Reason",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "limit-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:limit-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("queues back-to-back steers without cancel and waits for a streaming background reply after steer end_turn", async () => {
    let promptCount = 0;
    let cancelCount = 0;
    let finishFirstSteer: (() => void) | null = null;
    const { connector, instances } = connectorHarness({
      handleMessage(_instance, message) {
        if ("method" in message && message.method === "session/cancel") {
          cancelCount += 1;
          return true;
        }
        return false;
      },
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-multi",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          finishFirstSteer = () => {
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: textChunk("Steer 1 ACK"),
            });
            instance.respond(request, { stopReason: "end_turn" });
          };
          return true;
        }
        // During steer 2, the background tool finishes and begins streaming its reply before end_turn.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg-multi",
            status: "completed",
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Background reply part 1 "),
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-multi-steer",
      label: "Deferred Multi Steer",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 50, quietLimitMs: 1_500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "multi-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-multi",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Send two back-to-back steers while steer 1 is still awaiting its wire response.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-a",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "first follow-up" }] },
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-b",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "second follow-up" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "steer-a" &&
          event.result.type === "steer",
      );
      expect(cancelCount).toBe(0);

      // Release steer 1; steer 2 runs next, gets accepted, and completes bg-multi while starting its reply.
      await expect.poll(() => finishFirstSteer).not.toBeNull();
      finishFirstSteer!();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "steer-b" &&
          event.result.type === "steer",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("Background reply part 1"),
      );

      // Turn must remain open past settleDelayMs (50ms) until part 2 and usage_update arrive.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:multi-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("part 2."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 350, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:multi-turn" &&
          event.state === "completed",
      );
      expect(cancelCount).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "assistant_message",
            text: "Background reply part 1 part 2.",
          }),
        }),
      );
    } finally {
      await connection.close();
    }
  });

  it("delivers a queued steer even when an earlier steer returns max_turn_requests", async () => {
    let promptCount = 0;
    let finishFirstSteer: (() => void) | null = null;
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-drop",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          finishFirstSteer = () => instance.respond(request, { stopReason: "max_turn_requests" });
          return true;
        }
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Second steer delivered"),
        });
        instance.respond(request, { stopReason: "max_turn_requests" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-steer-deliver",
      label: "Deferred Steer Deliver",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "drop-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-drop",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-1",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "first steer" }] },
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-2",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "second steer" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "steer-2" &&
          event.result.type === "steer",
      );
      await expect.poll(() => finishFirstSteer).not.toBeNull();
      finishFirstSteer!();
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Second steer delivered",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:drop-turn" &&
          event.state === "completed",
      );
      expect(promptCount).toBe(3);
    } finally {
      await connection.close();
    }
  });

  it("ignores steer usage_update from before a background tool finishes so the background reply is not cut short", async () => {
    let promptCount = 0;
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-usage",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
        } else {
          // Steer replies and emits usage_update while bg-usage is still in_progress.
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: textChunk("Steer reply"),
          });
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: { sessionUpdate: "usage_update", used: 150, size: 1000 },
          });
        }
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-steer-usage",
      label: "Deferred Steer Usage",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 40, quietLimitMs: 1_500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "usage-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-usage",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Steer completes with its own reply + usage_update while bg-usage is still running.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-usage",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "status?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Steer reply",
      );

      // Now bg-usage completes. The earlier steer usage_update must NOT trigger the 40ms timer.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-usage", status: "completed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:usage-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Background reply arrives after the thinking gap and closes with usage_update.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Background result ready."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 250, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:usage-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("ignores steer usage_update when the background tool completes during the steer request", async () => {
    let promptCount = 0;
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-mid-steer",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
        } else {
          // Tool completes while steer is in flight, followed by steer reply + steer usage_update.
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "bg-mid-steer",
              status: "completed",
            },
          });
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: textChunk("Steer reply"),
          });
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: { sessionUpdate: "usage_update", used: 180, size: 1000 },
          });
        }
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-mid-steer-usage",
      label: "Deferred Mid-Steer Usage",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 40, quietLimitMs: 1_500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "mid-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-mid-steer",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-mid",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "status?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Steer reply",
      );

      // Must NOT settle after 40ms settleDelayMs using the steer's usage_update.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:mid-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Background reply arrives after the steer and settles via its own usage_update.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Background result."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 260, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:mid-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("reports a notice and still delivers a queued steer when an earlier steer rejects with an RPC error", async () => {
    let promptCount = 0;
    let failFirstSteer: (() => void) | null = null;
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-rpc-err",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          failFirstSteer = () => instance.reject(request, "Transient steer error");
          return true;
        }
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Second steer succeeded"),
        });
        instance.respond(request, { stopReason: "max_turn_requests" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-steer-rpc-err",
      label: "Deferred Steer RPC Err",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "rpc-err-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-rpc-err",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-fail",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "first" }] },
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-next",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "second" }] },
        },
      });
      await expect.poll(() => failFirstSteer).not.toBeNull();
      failFirstSteer!();

      await waitForEvent(
        events,
        (event) =>
          event.type === "session.notice" &&
          event.notice.severity === "error" &&
          event.notice.description?.includes("Transient steer error") === true,
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "Second steer succeeded",
      );
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:rpc-err-turn" &&
          event.state === "completed",
      );
      expect(promptCount).toBe(3);
    } finally {
      await connection.close();
    }
  });

  it("keeps the background job running when a lone steer rejects and cancels cleanly if Stop raced the rejection", async () => {
    let promptCount = 0;
    let rejectHeldSteer: (() => void) | null = null;
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-keep-alive",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          instance.reject(request, "Steer rejected");
          return true;
        }
        if (promptCount === 3) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-cancel-race",
              name: "run_command",
              title: "Cancelable job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 4) {
          rejectHeldSteer = () => instance.reject(request, "Request aborted");
          return true;
        }
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-lone-steer-reject",
      label: "Deferred Lone Steer Reject",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");

      // Case 1: Lone steer rejects while bg-keep-alive is still running -> notice emitted, turn stays open.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "keep-alive-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-keep-alive",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "lone-steer-fail",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "status?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.notice" &&
          event.notice.severity === "error" &&
          event.notice.description?.includes("Steer rejected") === true,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:keep-alive-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "bg-keep-alive",
          status: "completed",
        },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Job finished."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 200, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:keep-alive-turn" &&
          event.state === "completed",
      );

      // Case 2: Explicit Stop before steer rejects -> turn reports canceled, not failed.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "cancel-race-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start 2" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-cancel-race",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "raced-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "follow up" }] },
        },
      });
      await expect.poll(() => rejectHeldSteer).not.toBeNull();
      await connection.send({
        type: "session.interrupt",
        requestId: "stop-race",
        sessionId: "session-1",
      });
      // Unanswered steer past cancelTimeoutMs cancels the turn and fails the wedged runtime
      // so the session is recovered instead of overlapping late updates with a new prompt.
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:cancel-race-turn" &&
          event.state === "canceled",
      );
      await waitForEvent(events, (event) => event.type === "session.closed");
      expect(instances[1].readsCanceled).toBe(true);

      // Direct prompts to the retired session must fail cleanly instead of reusing it.
      await expect(
        connection.send({
          type: "session.prompt",
          sessionId: "session-1",
          prompt: {
            clientMessageId: "after-retire",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "should fail" }] },
          },
        }),
      ).rejects.toThrow("Unknown session");
    } finally {
      await connection.close();
    }
  });

  it("terminates a command-backed ACP child process when an interrupted steer retires the session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-wedged-steer-"));
    const pidFile = path.join(dir, "session.pid");
    const script = path.join(dir, "wedged-agent.cjs");
    await writeFile(
      script,
      `
      const { writeFileSync } = require("node:fs");
      const { createInterface } = require("node:readline");
      const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
      let promptCount = 0;
      createInterface({ input: process.stdin }).on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          writeFileSync(process.env.PID_FILE, String(process.pid));
          send({ id: msg.id, result: { sessionId: "wedged-s1", configOptions: [] } });
        } else if (msg.method === "session/prompt") {
          promptCount += 1;
          if (promptCount === 1) {
            send({ method: "session/update", params: { sessionId: "wedged-s1", update: {
              sessionUpdate: "tool_call", toolCallId: "bg-wedged", name: "run_command",
              title: "Background job", status: "in_progress",
            } } });
            send({ id: msg.id, result: { stopReason: "end_turn" } });
          }
          // Prompt 2 (the steer) is intentionally never answered, even after session/cancel.
        } else if (msg.method === "session/close") {
          send({ id: msg.id, result: {} });
        }
      });
      `,
    );
    const registration = runAcpProvider({
      id: "wedged-command-acp",
      label: "Wedged Command ACP",
      command: [process.execPath, script],
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 25, quietLimitMs: 500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      const open = openInput();
      await connection.send({
        ...open,
        config: { ...open.config, env: { PID_FILE: pidFile } },
      });
      await waitForEvent(events, (event) => event.type === "session.ready");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "wedged-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-wedged",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "wedged-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "hang here" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "wedged-steer" &&
          event.result.type === "steer",
      );

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "wedged-replacement",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "replace wedged turn" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:wedged-1" &&
          event.state === "canceled",
      );
      await waitForEvent(events, (event) => event.type === "session.closed");
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "wedged-replacement" &&
          event.result.type === "failed",
      );
      expect(
        events.some(
          (event) => event.type === "session.turn" && event.turnId === "acp:wedged-replacement",
        ),
      ).toBe(false);

      // The wedged child process must actually be terminated.
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return "alive";
          } catch {
            return "dead";
          }
        })
        .toBe("dead");
    } finally {
      await connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let excluded daemon tool updates delay settlement of a completed background job", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "daemon-chatty",
            name: "run_command",
            title: "Dev server",
            status: "in_progress",
            rawInput: { CommandLine: "npm run dev", IsDaemon: true },
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "build-job",
            name: "run_command",
            title: "Build",
            status: "in_progress",
            rawInput: { CommandLine: "npm run build" },
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-chatty-daemon",
      label: "Deferred Chatty Daemon",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 60,
          quietLimitMs: 1_500,
          keepsTurnOpen(toolCall) {
            const input = toolCall.input;
            return !(
              typeof input === "object" &&
              input !== null &&
              !Array.isArray(input) &&
              input.IsDaemon === true
            );
          },
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    let daemonTicker: ReturnType<typeof setInterval> | null = null;
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "chatty-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "build" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "build-job",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Build completes and sends reply + usage_update while daemon emits updates every 20ms.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "build-job", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Build succeeded."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 120, size: 1000 },
      });
      let tick = 0;
      daemonTicker = setInterval(() => {
        tick += 1;
        instances[1].notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "daemon-chatty",
            status: "in_progress",
            rawOutput: { stdout: `log ${tick}` },
          },
        });
      }, 20);

      // Turn must still settle in ~60ms despite the daemon updates every 20ms.
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:chatty-turn" &&
          event.state === "completed",
      );
    } finally {
      if (daemonTicker) clearInterval(daemonTicker);
      await connection.close();
    }
  });

  it("releases a deferred turn when a running tool is later reclassified as an excluded daemon", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "late-daemon",
            name: "run_command",
            title: "Dev server",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-late-daemon",
      label: "Deferred Late Daemon",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 25,
          quietLimitMs: 60,
          keepsTurnOpen(toolCall) {
            const input = toolCall.input;
            return !(
              typeof input === "object" &&
              input !== null &&
              !Array.isArray(input) &&
              input.IsDaemon === true
            );
          },
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "late-daemon-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start dev server" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "late-daemon",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Late update supplies IsDaemon: true -> leaves qualifying work and arms quietLimitMs.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "late-daemon",
          rawInput: { CommandLine: "npm run dev", IsDaemon: true },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:late-daemon-turn" &&
          event.state === "completed",
      );
    } finally {
      await connection.close();
    }
  });

  it("does not delay reply settlement when a completed tool receives late output", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "late-out-tool",
            name: "run_command",
            title: "Build",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-late-output",
      label: "Deferred Late Output",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "late-out-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "build" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "late-out-tool",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Tool completes, post-tool reply and usage_update arm the short settleDelayMs timer.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "late-out-tool",
          status: "completed",
        },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Build succeeded."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 200, size: 1000 },
      });
      // Late output on the already-completed tool must not reset the short reply timer to quietLimitMs.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "late-out-tool",
          rawOutput: { output: "trailing log line" },
        },
      });

      const startedAt = Date.now();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:late-out-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      await connection.close();
    }
  });

  it("settles on the reply timer when reply text starts before the last background tool completes", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bg-a",
            name: "run_command",
            title: "Job A",
            status: "in_progress",
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bg-b",
            name: "run_command",
            title: "Job B",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-overlap-reply",
      label: "Deferred Overlap Reply",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "overlap-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run both jobs" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-b",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Job A finishes and assistant starts streaming the reply while Job B is still running.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-a", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Both jobs are finishing up."),
      });
      // Job B completes, then the reply's usage_update arrives -> should settle via settleDelayMs.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-b", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 300, size: 1000 },
      });

      const startedAt = Date.now();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:overlap-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      await connection.close();
    }
  });

  it("settles on the reply timer when reply usage arrives before the final background tool completes", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bg-u1",
            name: "run_command",
            title: "Job 1",
            status: "in_progress",
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bg-u2",
            name: "run_command",
            title: "Job 2",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-usage-before-tool",
      label: "Deferred Usage Before Tool",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "usage-first-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run jobs" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-u2",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Job 1 finishes, reply + usage_update arrive while Job 2 is still running.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-u1", status: "completed" },
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("All done."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 300, size: 1000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Still running because Job 2 has not completed yet.
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:usage-first-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Job 2 completes -> should settle via settleDelayMs, not quietLimitMs.
      const startedAt = Date.now();
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "bg-u2", status: "completed" },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:usage-first-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      await connection.close();
    }
  });

  it("defers the turn when a running tool completes immediately after end_turn in the same batch", async () => {
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "bg-race",
            name: "run_command",
            title: "Fast background job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        // Completion arrives right after end_turn in the same wire batch.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg-race",
            status: "completed",
          },
        });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-post-end-turn-race",
      label: "Deferred Post End Turn Race",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "race-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run fast bg job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-race" &&
          event.item.status === "completed",
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Turn must still be open waiting for the post-tool reply.
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:race-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Post-tool reply + usage_update arrive and settle the deferred turn.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("Background job finished."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 250, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:race-turn" &&
          event.state === "completed",
        400,
      );
      expect(
        events.some(
          (event) =>
            event.type === "timeline.item" &&
            event.item.type === "assistant_message" &&
            event.item.text === "Background job finished.",
        ),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("does not defer when an open tool is reclassified as an excluded daemon immediately after end_turn", async () => {
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "daemon-race",
            name: "run_command",
            title: "Dev server",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        // Reclassification to IsDaemon: true arrives in the same batch right after end_turn.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "daemon-race",
            rawInput: { CommandLine: "npm run dev", IsDaemon: true },
          },
        });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-daemon-race",
      label: "Deferred Daemon Race",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 30,
          quietLimitMs: 1_500,
          keepsTurnOpen(toolCall) {
            const input = toolCall.input;
            return !(
              typeof input === "object" &&
              input !== null &&
              !Array.isArray(input) &&
              input.IsDaemon === true
            );
          },
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      const startedAt = Date.now();
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "daemon-race-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "start dev server" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:daemon-race-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      await connection.close();
    }
  });

  it("settles on the reply timer when background completion and reply arrive immediately after steer end_turn", async () => {
    let promptCount = 0;
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-after-steer",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        // Steer response followed immediately in the same wire batch by background completion + reply + usage.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Steer ACK"),
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
        });
        instance.respond(request, { stopReason: "end_turn" });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg-after-steer",
            status: "completed",
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Background finished."),
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: { sessionUpdate: "usage_update", used: 300, size: 1000 },
        });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-post-steer-batch",
      label: "Deferred Post Steer Batch",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 40,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "post-steer-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run bg" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-after-steer",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const startedAt = Date.now();
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "post-steer-followup",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "status?" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:post-steer-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      await connection.close();
    }
  });

  it("preserves a settled background reply across a second queued steer with no new background work", async () => {
    let promptCount = 0;
    let releaseSteer1: (() => void) | null = null;
    const { connector } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-two-steers",
              name: "run_command",
              title: "Background job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          releaseSteer1 = () => {
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: textChunk("Steer 1 ACK"),
            });
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
            });
            instance.respond(request, { stopReason: "end_turn" });
            // Background job finishes and replies immediately after Steer 1 returns end_turn.
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "bg-two-steers",
                status: "completed",
              },
            });
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: textChunk("Background finished."),
            });
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: { sessionUpdate: "usage_update", used: 250, size: 1000 },
            });
          };
          return true;
        }
        // Steer 2 returns end_turn with no new background work.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Steer 2 ACK"),
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-two-steers-settled",
      label: "Deferred Two Steers Settled",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 40,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "two-steers-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run bg" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-two-steers",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Queue two steers back-to-back.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-one",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "first steer" }] },
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "steer-two",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "second steer" }] },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const startedAt = Date.now();
      releaseSteer1!();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:two-steers-turn" &&
          event.state === "completed",
        400,
      );
      expect(Date.now() - startedAt).toBeLessThan(400);
      expect(promptCount).toBe(3);
    } finally {
      await connection.close();
    }
  });

  it("keeps the turn open for a second background tool reply that starts during a second steer", async () => {
    let promptCount = 0;
    let releaseSteer1: (() => void) | null = null;
    const { connector, instances } = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-s1",
              name: "run_command",
              title: "Job 1",
              status: "in_progress",
            },
          });
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-s2",
              name: "run_command",
              title: "Job 2",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        if (promptCount === 2) {
          releaseSteer1 = () => {
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: textChunk("Steer 1 ACK"),
            });
            instance.respond(request, { stopReason: "end_turn" });
            // Job 1 finishes and sends its reply + usage while Job 2 is STILL running.
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "bg-s1",
                status: "completed",
              },
            });
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: textChunk("Job 1 done."),
            });
            instance.notify("session/update", {
              sessionId: "connector-session",
              update: { sessionUpdate: "usage_update", used: 200, size: 1000 },
            });
          };
          return true;
        }
        // During Steer 2, Job 2 completes and starts streaming its reply before Steer 2 ends.
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "bg-s2",
            status: "completed",
          },
        });
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: textChunk("Job 2 part 1 "),
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const registration = runAcpProvider({
      id: "deferred-second-tool-steer",
      label: "Deferred Second Tool Steer",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: {
          settleDelayMs: 40,
          quietLimitMs: 1_500,
        },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "two-tool-steer-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run two jobs" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-s2",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "two-tool-steer-1",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "steer 1" }] },
        },
      });
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "two-tool-steer-2",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "steer 2" }] },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      releaseSteer1!();
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("Job 2 part 1"),
      );

      // Pause longer than settleDelayMs (40ms): turn must stay open for Job 2's remaining chunks.
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:two-tool-steer-turn" &&
            event.state !== "started",
        ),
      ).toBe(false);

      // Job 2 finishes streaming and sends usage_update -> turn now completes cleanly.
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: textChunk("and part 2."),
      });
      instances[1].notify("session/update", {
        sessionId: "connector-session",
        update: { sessionUpdate: "usage_update", used: 350, size: 1000 },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:two-tool-steer-turn" &&
          event.state === "completed",
        400,
      );
    } finally {
      await connection.close();
    }
  });

  it("waits for process exit and emits terminal events once across overlapping interrupts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-overlap-interrupt-"));
    temporaryDirectories.push(dir);
    const scriptPath = path.join(dir, "slow-exit-acp.mjs");
    const pidFile = path.join(dir, "child.pid");
    await writeFile(
      scriptPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { createInterface } from "node:readline";`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 250); });`,
        `const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");`,
        `let prompts = 0;`,
        `createInterface({ input: process.stdin }).on("line", (line) => {`,
        `  if (!line.trim()) return;`,
        `  const msg = JSON.parse(line);`,
        `  if (msg.method === "initialize") {`,
        `    write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });`,
        `    return;`,
        `  }`,
        `  if (msg.method === "session/new") {`,
        `    write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "slow-session" } });`,
        `    return;`,
        `  }`,
        `  if (msg.method === "session/prompt") {`,
        `    prompts += 1;`,
        `    if (prompts === 1) {`,
        `      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "slow-session", update: { sessionUpdate: "tool_call", toolCallId: "slow-bg", name: "run_command", title: "Job", status: "in_progress" } } });`,
        `      write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });`,
        `    }`,
        `  }`,
        `});`,
      ].join("\n"),
      "utf8",
    );
    const registration = runAcpProvider({
      id: "deferred-overlap-interrupt",
      label: "Deferred Overlap Interrupt",
      command: [process.execPath, scriptPath],
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 1_500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "slow-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "slow-bg",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Start a hung steer so the session is actively awaiting a steer response.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "slow-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "steer" }] },
        },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "slow-steer",
      );

      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      await Promise.all([
        connection.send({
          type: "session.interrupt",
          requestId: "int-1",
          sessionId: "session-1",
        }),
        connection.send({
          type: "session.interrupt",
          requestId: "int-2",
          sessionId: "session-1",
        }),
      ]);
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "int-1",
      );
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "int-2",
      );

      // Both interrupts waited for the process to exit. On POSIX it lives 250ms past SIGTERM, so an
      // interrupt that returned early would find it alive; Windows ends it at once.
      expect(() => process.kill(childPid, 0)).toThrow();

      // Canceled turn and session.closed were each emitted exactly once.
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:slow-turn" &&
            event.state === "canceled",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "session.closed")).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it("lets deferred retirement be the sole emitter of cancellation when a steer returns cancelled during a slow cancel write", async () => {
    let promptCount = 0;
    let respondSteerCancelled: (() => void) | null = null;
    let releaseCancelWrite: (() => void) | null = null;
    let closedConnector = false;
    const base = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        promptCount += 1;
        if (promptCount === 1) {
          instance.notify("session/update", {
            sessionId: "connector-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "bg-slow-cancel",
              name: "run_command",
              title: "Job",
              status: "in_progress",
            },
          });
          instance.respond(request, { stopReason: "end_turn" });
          return true;
        }
        respondSteerCancelled = () => instance.respond(request, { stopReason: "cancelled" });
        return true;
      },
    });
    const connector = async () => {
      const inner = await base.connector();
      closedConnector = false;
      const writer = inner.writable.getWriter();
      const writable = new WritableStream<AcpStreamMessage>({
        async write(message) {
          if ("method" in message && message.method === "session/cancel") {
            respondSteerCancelled?.();
            await new Promise<void>((resolve) => {
              releaseCancelWrite = resolve;
            });
          }
          await writer.write(message);
        },
        async close() {
          closedConnector = true;
          await writer.close();
        },
        async abort(reason) {
          closedConnector = true;
          await writer.abort(reason);
        },
      });
      return { readable: inner.readable, writable };
    };
    const registration = runAcpProvider({
      id: "deferred-slow-cancel-steer",
      label: "Deferred Slow Cancel Steer",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 1_500 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "slow-cancel-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "bg-slow-cancel",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Start an in-flight steer, then initiate Stop while session/cancel write is held open.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "slow-cancel-steer",
          delivery: "steer",
          input: { type: "message", content: [{ type: "text", text: "steer" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "slow-cancel-steer",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const interruptPromise = connection.send({
        type: "session.interrupt",
        requestId: "slow-cancel-int",
        sessionId: "session-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Even though steer returned stopReason: "cancelled", retirement has not closed yet:
      // no canceled turn should be emitted yet, and a replacement prompt must be rejected.
      expect(closedConnector).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:slow-cancel-turn" &&
            event.state === "canceled",
        ),
      ).toBe(false);
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "replacement-during-retire",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "too early" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === "replacement-during-retire" &&
          event.result.type === "failed",
      );

      // Release the cancel write: retirement closes the transport and emits cancellation once.
      releaseCancelWrite!();
      await interruptPromise;
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "slow-cancel-int",
      );
      expect(closedConnector).toBe(true);
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:slow-cancel-turn" &&
            event.state === "canceled",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "session.closed")).toHaveLength(1);
    } finally {
      releaseCancelWrite?.();
      await connection.close();
    }
  });

  it("tears down a deferred ACP child when stdin stalls behind a large steer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-stalled-stdin-"));
    temporaryDirectories.push(dir);
    const scriptPath = path.join(dir, "stalled-stdin-acp.mjs");
    const pidFile = path.join(dir, "child.pid");
    await writeFile(
      scriptPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");`,
        `let buffer = "";`,
        `const onData = (chunk) => {`,
        `  buffer += chunk.toString("utf8");`,
        `  let idx;`,
        `  while ((idx = buffer.indexOf("\\n")) !== -1) {`,
        `    const line = buffer.slice(0, idx).trim();`,
        `    buffer = buffer.slice(idx + 1);`,
        `    if (!line) continue;`,
        `    const msg = JSON.parse(line);`,
        `    if (msg.method === "initialize") {`,
        `      write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });`,
        `    } else if (msg.method === "session/new") {`,
        `      write({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "stalled-session" } });`,
        `    } else if (msg.method === "session/prompt") {`,
        `      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stalled-session", update: { sessionUpdate: "tool_call", toolCallId: "stalled-bg", name: "run_command", title: "Job", status: "in_progress" } } });`,
        `      write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });`,
        `      // Stop reading stdin so a large follow-up steer fills the pipe buffer.`,
        `      process.stdin.off("data", onData);`,
        `      process.stdin.pause();`,
        `      setInterval(() => {}, 10_000);`,
        `      return;`,
        `    }`,
        `  }`,
        `};`,
        `process.stdin.on("data", onData);`,
      ].join("\n"),
      "utf8",
    );
    const registration = runAcpProvider({
      id: "deferred-stalled-stdin",
      label: "Deferred Stalled Stdin",
      command: [process.execPath, scriptPath],
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 5_000 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "stalled-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "stalled-bg",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Fill the child's stdin pipe buffer with a 2 MB steer while the child is paused.
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "stalled-steer",
          delivery: "steer",
          input: {
            type: "message",
            content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
          },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.prompt_result" && event.clientMessageId === "stalled-steer",
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      await connection.send({
        type: "session.interrupt",
        requestId: "stalled-int",
        sessionId: "session-1",
      });
      await waitForEvent(
        events,
        (event) => event.type === "request.completed" && event.requestId === "stalled-int",
        3_000,
      );
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(
        events.filter(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:stalled-turn" &&
            event.state === "canceled",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "session.closed")).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it("reports interrupt failure when a connector refuses to confirm shutdown within the deadline", async () => {
    let releaseStalledWrite: (() => void) | null = null;
    const base = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "stalled-conn-bg",
            name: "run_command",
            title: "Job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const connector = async () => {
      const inner = await base.connector();
      const writer = inner.writable.getWriter();
      const writable = new WritableStream<AcpStreamMessage>({
        async write(message) {
          if ("method" in message && message.method === "session/cancel") {
            await new Promise<void>((resolve) => {
              releaseStalledWrite = resolve;
            });
          }
          await writer.write(message);
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      });
      return { readable: inner.readable, writable };
    };
    const registration = runAcpProvider({
      id: "deferred-stalled-connector",
      label: "Deferred Stalled Connector",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 5_000 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "stalled-conn-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "stalled-conn-bg",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      await connection.send({
        type: "session.interrupt",
        requestId: "stalled-conn-int",
        sessionId: "session-1",
      });
      const failed = await waitForEvent(
        events,
        (event) => event.type === "request.failed" && event.requestId === "stalled-conn-int",
        3_000,
      );
      expect(failed.type === "request.failed" && failed.error.message).toContain(
        "ACP connector did not close",
      );
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:stalled-conn-turn" &&
            event.state === "canceled",
        ),
      ).toBe(false);

      // Once the connector finishes closing after the deadline, the turn and session retire cleanly.
      releaseStalledWrite!();
      await waitForEvent(
        events,
        (event) =>
          event.type === "session.turn" &&
          event.turnId === "acp:stalled-conn-turn" &&
          event.state === "canceled",
        2_000,
      );
      await waitForEvent(events, (event) => event.type === "session.closed", 2_000);
      expect(events.filter((event) => event.type === "session.closed")).toHaveLength(1);
    } finally {
      releaseStalledWrite?.();
      await connection.close();
    }
  });

  it("reports interrupt failure when a connector rejects readable shutdown", async () => {
    let connectorCall = 0;
    const base = connectorHarness({
      handleRequest(instance, request) {
        if (request.method !== "session/prompt") return false;
        instance.notify("session/update", {
          sessionId: "connector-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "reject-cancel-bg",
            name: "run_command",
            title: "Job",
            status: "in_progress",
          },
        });
        instance.respond(request, { stopReason: "end_turn" });
        return true;
      },
    });
    const connector = async () => {
      connectorCall += 1;
      const inner = await base.connector();
      if (connectorCall === 1) return inner;
      const reader = inner.readable.getReader();
      const readable = new ReadableStream<AcpStreamMessage>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          await reader.cancel();
          throw new Error("connector cancel rejected");
        },
      });
      return { readable, writable: inner.writable };
    };
    const registration = runAcpProvider({
      id: "deferred-reject-cancel",
      label: "Deferred Reject Cancel",
      connector,
      acpOptions: {
        deferTurnOnRunningTools: { settleDelayMs: 30, quietLimitMs: 5_000 },
      },
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "reject-cancel-turn",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "run job" }] },
        },
      });
      await waitForEvent(
        events,
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.id === "reject-cancel-bg",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      await connection.send({
        type: "session.interrupt",
        requestId: "reject-cancel-int",
        sessionId: "session-1",
      });
      const failed = await waitForEvent(
        events,
        (event) => event.type === "request.failed" && event.requestId === "reject-cancel-int",
        2_000,
      );
      expect(failed.type === "request.failed" && failed.error.message).toContain(
        "connector cancel rejected",
      );
      expect(
        events.some(
          (event) =>
            event.type === "session.turn" &&
            event.turnId === "acp:reject-cancel-turn" &&
            event.state === "canceled",
        ),
      ).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("does not enforce the deferred Stop deadline on non-deferred probe shutdown", async () => {
    const base = connectorHarness();
    const connector = async () => {
      const inner = await base.connector();
      const writer = inner.writable.getWriter();
      const writable = new WritableStream<AcpStreamMessage>({
        write: (message) => writer.write(message),
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 1_100));
          await writer.close();
        },
        abort: (reason) => writer.abort(reason),
      });
      return { readable: inner.readable, writable };
    };
    const registration = runAcpProvider({
      id: "slow-probe-close",
      label: "Slow Probe Close",
      connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    await connection.close();
  });
});

describe("ACP tool call rows", () => {
  function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  }

  function text(value: string) {
    return [{ type: "content", content: { type: "text", text: value } }];
  }

  async function toolRows(
    updates: unknown[],
    transformers?: Parameters<typeof runAcpProvider>[0]["transformers"],
  ) {
    const harness = connectorHarness({ promptUpdates: () => updates });
    const registration = runAcpProvider({
      id: "tool-rows-acp",
      label: "Tool rows ACP",
      connector: harness.connector,
      transformers,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "first",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Use a tool" }] },
        },
      });
      await waitForEvent(
        events,
        (event) => event.type === "session.turn" && event.state === "completed",
      );
      const rows = events.flatMap((event) =>
        event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
      );
      for (const row of rows) {
        expect(AgentTimelineItemPayloadSchema.safeParse(row).success).toBe(true);
      }
      return rows;
    } finally {
      await connection.close();
    }
  }

  it.each([
    {
      kind: "execute",
      start: { title: "Run tests", rawInput: { command: "npm", args: ["test"], cwd: "/repo" } },
      end: { content: text("passed"), rawOutput: { exitCode: 0 } },
      detail: { type: "shell", command: "npm test", cwd: "/repo", output: "passed", exitCode: 0 },
    },
    {
      kind: "execute",
      start: { title: "Run tests" },
      end: { content: text("passed") },
      detail: { type: "shell", command: "Run tests", output: "passed" },
    },
    {
      kind: "read",
      start: { title: "Read a.ts", locations: [{ path: "/repo/a.ts" }], rawInput: { offset: 3 } },
      end: { content: text("const a = 1;") },
      detail: { type: "read", filePath: "/repo/a.ts", content: "const a = 1;", offset: 3 },
    },
    {
      kind: "search",
      start: { title: "Search TODO", rawInput: { pattern: "TODO" } },
      end: { content: text("a.ts:1"), locations: [{ path: "/repo/a.ts" }] },
      detail: {
        type: "search",
        query: "TODO",
        toolName: "search",
        content: "a.ts:1",
        filePaths: ["/repo/a.ts"],
      },
    },
    {
      kind: "fetch",
      start: { title: "Fetch example", rawInput: { url: "https://example.com" } },
      end: { content: text("Example Domain") },
      detail: { type: "fetch", url: "https://example.com", result: "Example Domain" },
    },
    {
      kind: "edit",
      start: {
        title: "Edit a.ts",
        content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }],
      },
      end: {},
      detail: { type: "edit", filePath: "/repo/a.ts", oldString: "a", newString: "b" },
    },
    {
      kind: "edit",
      start: { title: "Edit a.ts", locations: [{ path: "/repo/a.ts" }] },
      end: { content: text("Replaced 1 occurrence") },
      detail: { type: "edit", filePath: "/repo/a.ts", unifiedDiff: "Replaced 1 occurrence" },
    },
    {
      kind: "edit",
      start: {
        title: "Edit a.ts",
        rawInput: { filePath: "/repo/a.ts", oldString: "remove me", newString: "  " },
      },
      end: {},
      detail: { type: "edit", filePath: "/repo/a.ts", oldString: "remove me", newString: "  " },
    },
    {
      kind: "delete",
      start: { title: "Delete a.ts", locations: [{ path: "/repo/a.ts" }] },
      end: {},
      detail: { type: "edit", filePath: "/repo/a.ts", newString: "" },
    },
    {
      kind: "think",
      start: { title: "Plan" },
      end: { content: text("First read the tests") },
      detail: { type: "plain_text", label: "Plan", icon: "brain", text: "First read the tests" },
    },
    {
      kind: "other",
      start: { title: "Update todos" },
      end: { content: text("2 open") },
      detail: { type: "plain_text", label: "Update todos", icon: "wrench", text: "2 open" },
    },
    {
      kind: "other",
      start: { title: "Custom tool", rawInput: { value: 1 } },
      end: { content: text("done"), rawOutput: { ok: true } },
      detail: { type: "unknown", input: { value: 1 }, output: { ok: true } },
    },
  ])("presents a completed $kind call as its standard row ($start.title)", async (example) => {
    const rows = await toolRows([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        kind: example.kind,
        status: "in_progress",
        ...example.start,
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        ...example.end,
      },
    ]);
    expect(rows.at(-1)?.detail).toEqual(example.detail);
  });

  it("gives transformers the call's content and the call as it was last presented", async () => {
    const commandFromStart: NonNullable<
      NonNullable<Parameters<typeof runAcpProvider>[0]["transformers"]>[number]["toolCall"]
    > = (call, { previous }) => {
      const first = Array.isArray(call.content) ? call.content[0] : undefined;
      const startText = jsonRecord(jsonRecord(first).content).text;
      if (typeof startText === "string" && startText.startsWith("$ ")) {
        return { ...call, input: { command: startText.slice(2) } };
      }
      const command = jsonRecord(previous?.input).command;
      return typeof command === "string" ? { ...call, input: { command } } : call;
    };
    const rows = await toolRows(
      [
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "git status + 1 command",
          kind: "execute",
          status: "in_progress",
          content: text("$ git status && git diff"),
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: text("clean"),
        },
      ],
      [{ toolCall: commandFromStart }],
    );
    expect(rows.map((row) => row.detail)).toEqual([
      { type: "shell", command: "git status && git diff", output: "$ git status && git diff" },
      { type: "shell", command: "git status && git diff", output: "clean" },
    ]);
  });

  it("keeps a transformer's own detail over the standard row", async () => {
    const rows = await toolRows(
      [
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Run tests",
          kind: "execute",
          status: "completed",
          rawInput: { command: "npm test" },
        },
      ],
      [
        {
          toolCall: (call) => ({
            ...call,
            detail: { type: "unknown", input: call.input, output: null },
          }),
        },
      ],
    );
    expect(rows.at(-1)?.detail).toEqual({
      type: "unknown",
      input: { command: "npm test" },
      output: null,
    });
  });

  it("shows the call's row on its approval", async () => {
    const harness = connectorHarness({
      handleRequest(runtime, request) {
        if (request.method !== "session/prompt") return false;
        void runtime.request("session/request_permission", {
          sessionId: "connector-session",
          toolCall: {
            toolCallId: "edit-1",
            title: "Edit a.ts",
            kind: "edit",
            status: "pending",
            content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }],
          },
          options: [
            { optionId: "allow", name: "Allow edit", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "approval-rows",
      label: "Approval rows",
      connector: harness.connector,
    }).connect({ versions: [1], capabilities: ["prompt.message", "permission"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      await connection.send({
        type: "session.prompt",
        sessionId: "session-1",
        prompt: {
          clientMessageId: "edit",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Edit a.ts" }] },
        },
      });
      expect(
        await waitForEvent(events, (event) => event.type === "session.permission"),
      ).toMatchObject({
        request: {
          id: "permission:edit-1",
          title: "Edit a.ts",
          detail: { type: "edit", filePath: "/repo/a.ts", oldString: "a", newString: "b" },
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("lists sessions across every page the agent returns", async () => {
    const pages: Record<string, { sessions: unknown[]; nextCursor?: string }> = {
      first: {
        sessions: [{ sessionId: "s1", cwd: "/repo", title: "One" }],
        nextCursor: "second",
      },
      second: { sessions: [{ sessionId: "s2", cwd: "/repo", title: "Two" }] },
    };
    const harness = connectorHarness({
      capabilities: { sessionCapabilities: { list: {} } },
      handleRequest(runtime, request) {
        if (request.method !== "session/list") return false;
        const { cursor } = request.params as { cursor?: string };
        runtime.respond(request, pages[cursor ?? "first"]);
        return true;
      },
    });
    const connection = await runAcpProvider({
      id: "paged-sessions",
      label: "Paged sessions",
      connector: harness.connector,
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.list"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({ type: "sessions", requestId: "list" });
      const listed = await waitForEvent(events, (event) => event.type === "sessions");
      expect(listed.type === "sessions" && listed.sessions.map((session) => session.title)).toEqual(
        ["One", "Two"],
      );
    } finally {
      await connection.close();
    }
  });

  it("resumes the generic ACP adapter's saved Auto Accept toggle in the unattended mode", async () => {
    const harness = connectorHarness({
      configOptions: [
        {
          id: "edit_approval_policy",
          name: "Edits",
          category: "mode",
          type: "select",
          currentValue: "ask",
          options: [
            { value: "ask", name: "Default" },
            { value: "session", name: "Don't Ask" },
          ],
        },
      ],
    });
    const connection = await runAcpProvider({
      id: "former-generic",
      label: "Former generic",
      connector: harness.connector,
      acpOptions: {
        autoAcceptMode: { mode: { id: "full-access", label: "Full access" }, nativeMode: "ask" },
      },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.configure"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      const input = openInput();
      input.config.settings = { auto_accept: true };
      await connection.send(input);
      await waitForEvent(events, (event) => event.type === "session.ready");
      const configs = events.flatMap((event) =>
        event.type === "session.config" ? [event.config.mode] : [],
      );
      expect(configs.at(-1)).toBe("full-access");
      const sentOptions = harness.instances
        .flatMap((instance) => instance.requests)
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => (request.params as { configId: string }).configId);
      expect(sentOptions).not.toContain("auto_accept");
      expect(events.some((event) => event.type === "request.failed")).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("keeps a mode chosen after the generic ACP adapter's Auto Accept toggle was saved", async () => {
    const harness = connectorHarness({
      configOptions: [
        {
          id: "edit_approval_policy",
          name: "Edits",
          category: "mode",
          type: "select",
          currentValue: "session",
          options: [
            { value: "ask", name: "Default" },
            { value: "session", name: "Don't Ask" },
          ],
        },
      ],
    });
    const connection = await runAcpProvider({
      id: "former-generic",
      label: "Former generic",
      connector: harness.connector,
      acpOptions: {
        autoAcceptMode: { mode: { id: "full-access", label: "Full access" }, nativeMode: "ask" },
      },
    }).connect({ versions: [1], capabilities: ["prompt.message", "session.configure"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      const input = openInput();
      input.config.mode = "ask";
      input.config.settings = { auto_accept: true };
      await connection.send(input);
      await waitForEvent(events, (event) => event.type === "session.ready");
      const configs = events.flatMap((event) =>
        event.type === "session.config" ? [event.config.mode] : [],
      );
      expect(configs.at(-1)).toBe("ask");
    } finally {
      await connection.close();
    }
  });
});

describe("runAcpProvider launch wrap", () => {
  async function wrapFixture(): Promise<{
    agent: string;
    launchLog: string;
    /** The wrap that runs the recording launcher as Node, tagged so the agent can tell. */
    wrap: (tag: string) => [string, ...string[]];
    launches: () => Promise<Array<{ argv: string[]; token: string | null }>>;
    agentStarts: () => Promise<string[]>;
  }> {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-acp-wrap-"));
    temporaryDirectories.push(directory);
    const launchLog = path.join(directory, "launches.jsonl");
    const agentLog = path.join(directory, "agent.log");
    const launcher = path.join(directory, "launcher.cjs");
    // Consumes two arguments of its own (log path, tag), records what it saw, then runs the rest.
    await writeFile(
      launcher,
      `const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [log, tag, command, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), token: process.env.SESSION_TOKEN ?? null }) + "\\n");
const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, WRAPPED_BY: tag } });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
`,
      "utf8",
    );
    const agent = path.join(directory, "agent.cjs");
    await writeFile(
      agent,
      `const { appendFileSync } = require("node:fs");
const record = (event) => appendFileSync(${JSON.stringify(agentLog)}, event + ":" + (process.env.WRAPPED_BY ?? "bare") + "\\n");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") { record("init"); send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } }); }
  else if (message.method === "session/new") { record("new"); send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-" + Math.random(), modes: null, configOptions: [] } }); }
});`,
      "utf8",
    );
    const readLines = async (file: string) =>
      (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return {
      agent,
      launchLog,
      wrap: (tag) => [process.execPath, launcher, launchLog, tag],
      launches: async () => (await readLines(launchLog)).map((line) => JSON.parse(line)),
      agentStarts: async () => await readLines(agentLog),
    };
  }

  function wrappedOpen(
    sessionId: string,
    wrap: readonly [string, ...string[]] | undefined,
  ): Extract<ProviderInput, { type: "session.open" }> {
    const input = openInput();
    return {
      ...input,
      requestId: `open-${sessionId}`,
      sessionId,
      config: { ...input.config, env: { SESSION_TOKEN: sessionId }, ...(wrap ? { wrap } : {}) },
    };
  }

  async function connectWrapped(command: readonly [string, ...string[]]) {
    const registration = runAcpProvider({ id: "wrap-acp", label: "Wrap ACP", command });
    expect(registration.launchWrap).toBe(true);
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.launch_wrap"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    return { connection, events };
  }

  it("spawns the session as [...wrap, command, ...args] with the session env", async () => {
    const fixture = await wrapFixture();
    const { launchLog } = fixture;
    const { connection, events } = await connectWrapped([process.execPath, fixture.agent]);
    expect(connection.capabilities).toContain("session.launch_wrap");
    try {
      await connection.send(wrappedOpen("one", fixture.wrap("sandbox")));
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect(await fixture.launches()).toEqual([
        { argv: [launchLog, "sandbox", process.execPath, fixture.agent], token: "one" },
      ]);
      expect(await fixture.agentStarts()).toEqual(["init:bare", "init:sandbox", "new:sandbox"]);
    } finally {
      await connection.close();
    }
  });

  it("passes wrap and command arguments that contain spaces as single argv elements", async () => {
    const fixture = await wrapFixture();
    const { launchLog } = fixture;
    const { connection, events } = await connectWrapped([
      process.execPath,
      fixture.agent,
      "--profile name with spaces",
    ]);
    try {
      await connection.send(wrappedOpen("one", fixture.wrap("tag with spaces")));
      await waitForEvent(events, (event) => event.type === "session.ready");
      expect((await fixture.launches())[0]?.argv).toEqual([
        launchLog,
        "tag with spaces",
        process.execPath,
        fixture.agent,
        "--profile name with spaces",
      ]);
    } finally {
      await connection.close();
    }
  });

  it("wraps only the session that selected a wrap on a shared connection", async () => {
    const fixture = await wrapFixture();
    const { launchLog } = fixture;
    const { connection, events } = await connectWrapped([process.execPath, fixture.agent]);
    try {
      await connection.send(wrappedOpen("wrapped", fixture.wrap("sandbox")));
      await connection.send(wrappedOpen("bare", undefined));
      await waitForEvent(
        events,
        (event) => event.type === "session.ready" && event.sessionId === "wrapped",
      );
      await waitForEvent(
        events,
        (event) => event.type === "session.ready" && event.sessionId === "bare",
      );
      expect(await fixture.launches()).toEqual([
        { argv: [launchLog, "sandbox", process.execPath, fixture.agent], token: "wrapped" },
      ]);
      expect(
        (await fixture.agentStarts()).filter((line) => line.startsWith("new:")).sort(),
      ).toEqual(["new:bare", "new:sandbox"]);
    } finally {
      await connection.close();
    }
  });

  it("fails the open when the launcher is missing and never starts the bare command", async () => {
    const fixture = await wrapFixture();
    const missing = path.join(path.dirname(fixture.agent), "missing-launcher");
    const { connection, events } = await connectWrapped([process.execPath, fixture.agent]);
    // Node publishes every spawn attempt, a failed one included, before it fills in the fields.
    const spawned: ChildProcess[] = [];
    const onSpawn = (message: unknown) =>
      spawned.push((message as { process: ChildProcess }).process);
    diagnosticsChannel.subscribe("child_process", onSpawn);
    try {
      await connection.send(wrappedOpen("one", [missing, "--profile", "a b"]));
      expect(await waitForEvent(events, (event) => event.type === "request.failed")).toMatchObject({
        requestId: "open-one",
        error: { message: expect.stringMatching(/ENOENT/u) },
      });
      // Closing the connection's idle capability probe on Windows spawns taskkill.exe.
      const launchedArgs = spawned
        .map((child) => child.spawnargs)
        .filter((args) => args[0]?.toLowerCase() !== "taskkill.exe");
      expect(launchedArgs).toEqual([
        [missing, "--profile", "a b", process.execPath, fixture.agent],
      ]);
      // The only start of the agent is the connection's capability probe, before the open.
      expect(await fixture.agentStarts()).toEqual(["init:bare"]);
      expect(events.some((event) => event.type === "session.opened")).toBe(false);
    } finally {
      diagnosticsChannel.unsubscribe("child_process", onSpawn);
      await connection.close();
    }
  });

  it("does not offer launch wrap through a connector", async () => {
    const { connector } = connectorHarness();
    const registration = runAcpProvider({ id: "connector-acp", label: "Connector", connector });
    expect(registration).not.toHaveProperty("launchWrap");
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.launch_wrap"],
    });
    expect(connection.capabilities).not.toContain("session.launch_wrap");
    await connection.close();
  });
});

describe("respectful ACP probing defaults and hygiene", () => {
  it("defaults catalogRefresh to on_demand and supplies a global getCatalogCacheKey hashed from launch", async () => {
    const registration = runAcpProvider({
      id: "default-acp",
      label: "Default ACP",
      command: ["/usr/bin/agent", "acp"],
    });
    expect(registration.catalogRefresh).toBe("on_demand");
    expect(registration.getCatalogCacheKey).toBeTypeOf("function");

    const launchA = { command: "/usr/bin/agent", args: ["acp"], env: { B: "2", A: "1" } };
    const launchAReorderedEnv = {
      command: "/usr/bin/agent",
      args: ["acp"],
      env: { A: "1", B: "2" },
    };
    const launchB = { command: "/usr/bin/agent", args: ["acp", "--v2"], env: { A: "1", B: "2" } };
    const launchC = { command: "/usr/bin/agent", args: ["acp"], env: { A: "1", B: "3" } };

    const keyGlobal = await registration.getCatalogCacheKey!({
      scope: "global",
      launch: launchA,
    });
    const keyWorkspace = await registration.getCatalogCacheKey!({
      scope: "workspace",
      cwd: "/tmp/ws-1",
      launch: launchAReorderedEnv,
    });
    const keyDifferentArgs = await registration.getCatalogCacheKey!({
      scope: "global",
      launch: launchB,
    });
    const keyDifferentEnv = await registration.getCatalogCacheKey!({
      scope: "global",
      launch: launchC,
    });

    expect(keyGlobal).toBeTruthy();
    expect(keyWorkspace).toBe(keyGlobal);
    expect(keyDifferentArgs).not.toBe(keyGlobal);
    expect(keyDifferentEnv).not.toBe(keyGlobal);

    const background = runAcpProvider({
      id: "background-acp",
      label: "Background ACP",
      command: ["/usr/bin/agent", "acp"],
      catalogRefresh: "background",
    });
    expect(background.catalogRefresh).toBe("background");
  });

  it("reuses the initialized capability probe for global discover() (1 spawn total) and cleans up on close", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "warm-probe-acp",
      label: "Warm Probe ACP",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: [],
      clientInfo: { name: "paseo", title: "Paseo", version: "0.17.5" },
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      expect(harness.instances).toHaveLength(1);
      await connection.send({ type: "catalog", requestId: "global-catalog" });
      expect(await waitForEvent(events, (event) => event.type === "catalog")).toMatchObject({
        type: "catalog",
        requestId: "global-catalog",
      });
      // connect() + global discover() shared the single initialized warmProbe instance.
      expect(harness.instances).toHaveLength(1);
      expect(countRequests(harness.instances[0]!, "initialize")).toBe(1);
      expect(countRequests(harness.instances[0]!, "session/new")).toBe(1);
      const initReq = harness.instances[0]!.requests.find((req) => req.method === "initialize");
      expect(initReq?.params).toMatchObject({
        clientInfo: { name: "paseo", title: "Paseo", version: "0.17.5" },
      });
      expect(harness.instances[0]).toMatchObject({ readsCanceled: true, writesClosed: true });
    } finally {
      await connection.close();
    }
  });

  it("closes an unused warmProbe when connection.close() runs without discover()", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "unused-warm-probe",
      label: "Unused Warm Probe",
      connector: harness.connector,
    });
    const connection = await registration.connect({ versions: [1], capabilities: [] });
    expect(harness.instances).toHaveLength(1);
    await connection.close();
    expect(harness.instances[0]).toMatchObject({ readsCanceled: true, writesClosed: true });
  });

  it("omits _meta when no transformer supplies metadata and never sends _meta._paseo", async () => {
    const harness = connectorHarness();
    const registration = runAcpProvider({
      id: "no-paseo-meta",
      label: "No Paseo Meta",
      connector: harness.connector,
    });
    const connection = await registration.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send(openInput());
      await waitForEvent(events, (event) => event.type === "session.ready");
      const sessionInstance = harness.instances[1]!;
      const newSessionReq = sessionInstance.requests.find((req) => req.method === "session/new");
      expect(newSessionReq?.params).not.toHaveProperty("_meta");
    } finally {
      await connection.close();
    }
  });
});
