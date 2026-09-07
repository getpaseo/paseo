import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSideConnection, PROTOCOL_VERSION, type Agent } from "@agentclientprotocol/sdk";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "./provider.js";
import { afterEach, describe, expect, it } from "vitest";
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
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings, persist: true },
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

type AcpRequestMessage = Extract<AcpStreamMessage, { id: string | number | null; method: string }>;

interface ConnectorInstance {
  readonly requests: AcpRequestMessage[];
  readsCanceled: boolean;
  writesClosed: boolean;
  closeFromAgent(): void;
  request(method: string, params: unknown): Promise<unknown>;
  respond(request: AcpRequestMessage, result: unknown): void;
  notify(method: string, params: unknown): void;
}

interface ConnectorResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ConnectorHarnessOptions {
  capabilities?: Record<string, unknown>;
  configOptions?: unknown[];
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
    expect(harness.instances[0]).toMatchObject({ readsCanceled: true, writesClosed: true });

    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send(openInput());
    await waitForEvent(events, (event) => event.type === "session.ready");
    await connection.close();

    expect(harness.instances).toHaveLength(2);
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

  it("commits transformer config notifications once and discards them on rollback", async () => {
    const executable = await fakeAcp(`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
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
    send({ jsonrpc: "2.0", method: "vendor/config", params: { model } });
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options() } });
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
