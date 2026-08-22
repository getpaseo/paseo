import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerTiming,
} from "./opencode/event-consumer.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

test("dispatches ascending OpenCode message identifiers through the public provider path", async () => {
  const upstream = await createRecoveryUpstream();
  const fixture = await createPublicRecoverySession(upstream, new RecoveryTiming());
  const observed: AgentStreamEvent[] = [];
  fixture.session.subscribe((event) => observed.push(event));
  await upstream.connected(1);
  upstream.send(0, connectedRecord());

  await fixture.session.startTurn("first");
  await upstream.dispatched(1);
  upstream.send(0, idleRecord());
  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  await fixture.session.startTurn("second");
  const ids = await upstream.dispatched(2);

  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(ids[1]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect((ids[0] as string) < (ids[1] as string)).toBe(true);

  await fixture.session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("recovers missed output after EOF without failing the active turn", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  expect(upstream.messageReads()).toBe(0);
  upstream.setRecoveredMessages(dispatchId as string);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());

  await eventually(() => expect(observed.map((event) => event.type)).toContain("turn_completed"));
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  const assistantTexts = observed.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
  expect(assistantTexts).toHaveLength(52);
  expect(assistantTexts.at(-1)).toBe("recovered output");
  expect(assistantTexts).not.toContain("before boundary");

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

test("orders queued live deltas behind an incomplete recovery snapshot and suppresses late output", async () => {
  const upstream = await createRecoveryUpstream();
  const timing = new RecoveryTiming();
  const fixture = await createPublicRecoverySession(upstream, timing);
  const { session } = fixture;
  const observed: AgentStreamEvent[] = [];
  session.subscribe((event) => observed.push(event));

  await upstream.connected(1);
  upstream.send(0, connectedRecord());
  await session.startTurn("hello");
  const [dispatchId] = await upstream.dispatched();
  upstream.send(0, assistantMessageRecord("message-race"));
  upstream.send(0, textDeltaRecord("message-race", "part-race", "Hello"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello"]));

  upstream.setStatus("busy");
  upstream.setMessages([
    { info: { id: dispatchId as string, sessionID: "session-1", role: "user" }, parts: [] },
    {
      info: { id: "message-race", sessionID: "session-1", role: "assistant" },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "",
          time: { start: 1 },
        },
      ],
    },
  ]);
  upstream.end(0);
  await timing.waiting();
  timing.advance();
  await upstream.connected(2);
  upstream.send(1, connectedRecord());
  upstream.send(1, textDeltaRecord("message-race", "part-race", " world"));
  await eventually(() => expect(assistantText(observed)).toEqual(["Hello", " world"]));

  upstream.setMessages([
    {
      info: {
        id: "message-race",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
      parts: [
        {
          id: "part-race",
          sessionID: "session-1",
          messageID: "message-race",
          type: "text",
          text: "Hello world!",
          time: { start: 1, end: 2 },
        },
      ],
    },
  ]);
  upstream.send(1, finalTextRecord("message-race", "part-race", "Hello world!"));
  upstream.send(1, {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  });
  upstream.send(1, textDeltaRecord("message-race", "part-race", " too late"));

  await eventually(() =>
    expect(observed.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
  expect(observed.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(observed.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  expect(observed.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
  expect(assistantText(observed)).toEqual(["Hello", " world", "!"]);
  expect(assistantText(observed).join("")).toBe("Hello world!");
  const ordered = observed.flatMap((event) => {
    if (event.type === "turn_started" || event.type === "turn_completed") return [event.type];
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      return [event.item.text];
    }
    return [];
  });
  expect(ordered).toEqual(["turn_started", "Hello", " world", "!", "turn_completed"]);

  await session.close();
  await fixture.manager.shutdown();
  await upstream.close();
});

class RecoveryTiming implements OpenCodeEventConsumerTiming {
  private resolveWait: (() => void) | null = null;
  arm(): () => void {
    return () => undefined;
  }
  wait(_delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  async waiting(): Promise<void> {
    await eventually(() => expect(this.resolveWait).not.toBeNull());
  }
  advance(): void {
    this.resolveWait?.();
    this.resolveWait = null;
  }
}

async function createPublicRecoverySession(
  upstream: Awaited<ReturnType<typeof createRecoveryUpstream>>,
  timing: OpenCodeEventConsumerTiming,
) {
  let serverProcess: RecoveryServerProcess | null = null;
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => upstream.port,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => process.cwd(),
    spawnServerProcess: () => {
      serverProcess = new RecoveryServerProcess();
      return serverProcess as unknown as ChildProcess;
    },
    terminateProcess: async () => {
      serverProcess?.exit();
      return "terminated";
    },
    createEventSource: (options) => new OpenCodeEventConsumer({ ...options, timing }),
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: manager,
    createClient: ({ baseUrl, directory }) => createOpencodeClient({ baseUrl, directory }),
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/workspace" });
  return { manager, session };
}

class RecoveryServerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42_001;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    queueMicrotask(() => this.stdout.emit("data", Buffer.from("listening on test server\n")));
  }

  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

async function createRecoveryUpstream() {
  const streams: ServerResponse[] = [];
  const dispatchIds: string[] = [];
  let messages: unknown[] = [];
  let messageReadCount = 0;
  let status: "busy" | "idle" = "idle";
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.url?.startsWith("/global/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      streams.push(response);
      return;
    }
    if (request.method === "POST" && pathname === "/session") {
      return json(response, { id: "session-1", directory: "/workspace" });
    }
    if (request.url?.includes("/prompt_async")) {
      const body = JSON.parse(await readBody(request)) as { messageID: string };
      dispatchIds.push(body.messageID);
      return json(response, {});
    }
    if (request.url?.includes("/message")) {
      messageReadCount += 1;
      return json(response, messages);
    }
    if (request.url?.includes("/status"))
      return json(response, status === "busy" ? { "session-1": { type: "busy" } } : {});
    return json(response, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    connected: async (count: number) => eventually(() => expect(streams).toHaveLength(count)),
    send(index: number, value: unknown) {
      streams[index]?.write(`data: ${JSON.stringify(value)}\n\n`);
    },
    end(index: number) {
      streams[index]?.end();
    },
    dispatched: async (count = 1) => {
      await eventually(() => expect(dispatchIds).toHaveLength(count));
      return [...dispatchIds];
    },
    messageReads: () => messageReadCount,
    setMessages(nextMessages: unknown[]) {
      messages = nextMessages;
    },
    setStatus(nextStatus: "busy" | "idle") {
      status = nextStatus;
    },
    setRecoveredMessages(messageId: string) {
      messages = [
        {
          info: {
            id: "msg_before_boundary",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-before",
              sessionID: "session-1",
              messageID: "msg_before_boundary",
              type: "text",
              text: "before boundary",
              time: { start: 1, end: 2 },
            },
          ],
        },
        {
          info: { id: messageId, sessionID: "session-1", role: "user" },
          parts: [],
        },
        ...Array.from({ length: 51 }, (_, index) => ({
          info: {
            id: `msg_step_${index}`,
            sessionID: "session-1",
            role: "assistant",
            time: { created: index + 3, completed: index + 4 },
          },
          parts: [
            {
              id: `part-step-${index}`,
              sessionID: "session-1",
              messageID: `msg_step_${index}`,
              type: "text",
              text: `step ${index}`,
              time: { start: index + 3, end: index + 4 },
            },
          ],
        })),
        {
          info: { id: "msg_compaction", sessionID: "session-1", role: "user" },
          parts: [
            {
              id: "part-compaction",
              sessionID: "session-1",
              messageID: "msg_compaction",
              type: "compaction",
              auto: true,
            },
          ],
        },
        {
          info: {
            id: "msg_assistant",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-1",
              messageID: "msg_assistant",
              type: "text",
              text: "recovered output",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function assistantMessageRecord(messageId: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.updated",
      properties: { info: { id: messageId, sessionID: "session-1", role: "assistant" } },
    },
  };
}

function textDeltaRecord(messageId: string, partId: string, delta: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: messageId,
        partID: partId,
        field: "text",
        delta,
      },
    },
  };
}

function finalTextRecord(messageId: string, partId: string, text: string) {
  return {
    directory: "/workspace",
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          id: partId,
          sessionID: "session-1",
          messageID: messageId,
          type: "text",
          text,
          time: { start: 1, end: 2 },
        },
      },
    },
  };
}

function assistantText(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

function connectedRecord() {
  return { directory: "/workspace", payload: { type: "server.connected", properties: {} } };
}

function idleRecord() {
  return {
    directory: "/workspace",
    payload: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}
