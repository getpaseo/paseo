import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { AgentManager } from "../agent-manager.js";
import { createLoggedWebSocketStream, type ACPWebSocketStreamHandle } from "./acp-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

interface WireRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface WireResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RemoteAgentOptions {
  bearerToken?: string;
  ignoreInitialize?: boolean;
  rejectAuth?: boolean;
  disconnectOn?: string;
  authMethods?: Array<{ id: string; name: string; type?: "terminal"; args?: string[] }>;
  requireAuth?: boolean;
  prompt?: (socket: WebSocket, request: WireRequest) => void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function startRemoteAgent(options: RemoteAgentOptions = {}) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: ({ req }) =>
      !options.bearerToken || req.headers.authorization === `Bearer ${options.bearerToken}`,
  });
  await once(server, "listening");
  const sockets = new Set<WebSocket>();
  const requests: WireRequest[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const responses = new Map<string, (response: WireResponse) => void>();
  let nextSession = 0;
  let nextRequest = 0;

  server.on("connection", (socket, request) => {
    sockets.add(socket);
    headers.push(request.headers);
    let authenticated = !options.requireAuth;
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireRequest | WireResponse;
      if (!("method" in message)) {
        responses.get(String(message.id))?.(message);
        responses.delete(String(message.id));
        return;
      }
      requests.push(message);
      if (message.method === options.disconnectOn) {
        socket.terminate();
        return;
      }
      const reply = (result: unknown) => {
        if (message.id !== undefined) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        }
      };
      switch (message.method) {
        case "initialize":
          if (options.ignoreInitialize) break;
          reply({
            protocolVersion: 1,
            agentInfo: { name: "remote-test-agent", version: "1" },
            agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} } },
            authMethods: options.authMethods ?? [{ id: "oauth", name: "Sign in with OAuth" }],
          });
          break;
        case "authenticate":
          if (options.rejectAuth) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: "Sign-in rejected" },
              }),
            );
            break;
          }
          authenticated = true;
          reply({});
          break;
        case "session/new":
          if (!authenticated) {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: "Authentication required" },
              }),
            );
            break;
          }
          reply({
            sessionId: `remote-${++nextSession}`,
            models: {
              currentModelId: "remote-model",
              availableModels: [{ modelId: "remote-model", name: "Remote model" }],
            },
          });
          break;
        case "session/load":
          reply({});
          break;
        case "session/list":
          reply({ sessions: [] });
          break;
        case "session/prompt":
          if (options.prompt) {
            options.prompt(socket, message);
          } else {
            socket.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: message.params.sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Remote response" },
                  },
                },
              }),
            );
            reply({ stopReason: "end_turn" });
          }
          break;
        case "session/close":
          reply({});
          break;
        case "session/cancel":
          break;
        default:
          reply({});
      }
    });
  });

  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/acp`,
    requests,
    headers,
    sockets,
    async request(method: string, params: Record<string, unknown>): Promise<WireResponse> {
      const socket = [...sockets].at(-1);
      if (!socket) throw new Error("No connected ACP client");
      const id = `agent-request-${++nextRequest}`;
      const response = new Promise<WireResponse>((resolve) => responses.set(id, resolve));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return response;
    },
  };
}

describe("remote ACP over WebSocket", () => {
  test.each([
    "ws://agents.invalid/acp",
    "ws://127.0.0.1.agents.invalid/acp",
    "ws://127.0.0.1@192.0.2.1/acp",
    "http://127.0.0.1/acp",
    "ws+unix:///tmp/acp.sock",
  ])("enforces secure endpoints at the socket boundary for %s", async (url) => {
    let handle: ACPWebSocketStreamHandle | undefined;
    try {
      expect(() => {
        handle = createLoggedWebSocketStream(url, {
          provider: "acp",
          logger: createTestLogger(),
          headers: { Cookie: "private-test-cookie" },
        });
      }).toThrow("ACP WebSocket URLs require wss://");
    } finally {
      await handle?.close();
    }
  });

  test("cancellation and repeated cleanup do not close an already-cancelled stream", async () => {
    const remote = await startRemoteAgent();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const handle = createLoggedWebSocketStream(remote.url, { provider: "acp", logger });
    cleanups.push(() => handle.close());
    await handle.ready;
    await handle.stream.readable.cancel();
    await handle.closed;
    await handle.close();
    expect(warn).not.toHaveBeenCalled();
  });

  test("logs unexpected readable cleanup errors and still closes the socket", async () => {
    const remote = await startRemoteAgent();
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const handle = createLoggedWebSocketStream(remote.url, { provider: "acp", logger });
    cleanups.push(() => handle.close());
    await handle.ready;
    const failure = new Error("injected stream cleanup failure");
    const close = vi
      .spyOn(ReadableStreamDefaultController.prototype, "close")
      .mockImplementationOnce(() => {
        throw failure;
      });
    try {
      await handle.close();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        { err: failure, provider: "acp" },
        "Failed to close ACP WebSocket readable stream",
      );
    } finally {
      close.mockRestore();
      await handle.stream.readable.cancel();
    }
  });

  test("replays a disconnect to a subscriber attached after connection loss", async () => {
    const remote = await startRemoteAgent();
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    cleanups.push(() => session.close());
    const before: AgentStreamEvent[] = [];
    session.subscribe((event) => before.push(event));
    for (const socket of remote.sockets) socket.terminate();
    await vi.waitFor(() =>
      expect(before).toContainEqual(expect.objectContaining({ type: "turn_failed" })),
    );
    const after: AgentStreamEvent[] = [];
    session.subscribe((event) => after.push(event));
    expect(after).toContainEqual(
      expect.objectContaining({
        type: "turn_failed",
        error: expect.stringContaining("Remote ACP WebSocket closed"),
      }),
    );
  });

  test("normal session close does not emit a disconnect failure", async () => {
    const remote = await startRemoteAgent();
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.close();
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  });

  test("projects an idle disconnect into the managed agent error lifecycle", async () => {
    const remote = await startRemoteAgent();
    const logger = createTestLogger();
    const client = new GenericACPAgentClient({
      logger,
      transport: { type: "websocket", url: remote.url },
    });
    const manager = new AgentManager({ clients: { acp: client }, logger });
    const agent = await manager.createAgent({ provider: "acp", cwd: tmpdir() }, undefined, {
      workspaceId: undefined,
    });
    cleanups.push(() => manager.closeAgent(agent.id));
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    for (const socket of remote.sockets) socket.terminate();
    await vi.waitFor(() => expect(manager.getAgent(agent.id)?.lifecycle).toBe("error"));
    expect(manager.getAgent(agent.id)?.lastError).toContain("Remote ACP WebSocket closed");
  });

  test("uses the same authenticated transport for catalog, prompt, resume, and cleanup", async () => {
    const remote = await startRemoteAgent({
      requireAuth: true,
      bearerToken: "test-oauth-access-token",
    });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      providerId: "remote-agent",
      transport: {
        type: "websocket",
        url: remote.url,
        bearerTokenEnv: "PASEO_TEST_REMOTE_ACP_TOKEN",
        cwd: "/remote/workspace",
        headers: { "X-ACP-Test": "remote" },
      },
      authMethodId: "oauth",
      env: { PASEO_TEST_REMOTE_ACP_TOKEN: "test-oauth-access-token" },
    });

    await expect(client.isAvailable()).resolves.toBe(true);
    const catalog = await client.fetchCatalog({ scope: "workspace", cwd: tmpdir(), force: true });
    expect(catalog.models).toEqual([expect.objectContaining({ id: "remote-model" })]);
    const session = await client.createSession({
      provider: "acp",
      cwd: tmpdir(),
      mcpServers: { local: { type: "stdio", command: "must-not-run-on-the-remote-host" } },
    });
    const result = await session.run("hello");
    expect(result.finalText).toBe("Remote response");
    const handle = session.describePersistence();
    expect(handle).not.toBeNull();
    await session.close();

    const resumed = await client.resumeSession(handle!);
    await resumed.close();
    await vi.waitFor(() => expect(remote.sockets.size).toBe(0));

    expect(remote.headers).toHaveLength(3);
    expect(
      remote.headers.every((headers) => headers.authorization === "Bearer test-oauth-access-token"),
    ).toBe(true);
    expect(remote.headers.every((headers) => headers["x-acp-test"] === "remote")).toBe(true);
    expect(remote.requests.filter((request) => request.method === "initialize")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
      }),
      expect.objectContaining({ params: expect.any(Object) }),
      expect.objectContaining({ params: expect.any(Object) }),
    ]);
    expect(remote.requests.filter((request) => request.method === "authenticate")).toHaveLength(3);
    expect(remote.requests.filter((request) => request.method === "session/close")).toHaveLength(3);
    expect(remote.requests.filter((request) => request.method === "session/new")).toEqual([
      expect.objectContaining({ params: { cwd: "/remote/workspace", mcpServers: [] } }),
      expect.objectContaining({ params: { cwd: "/remote/workspace", mcpServers: [] } }),
    ]);
    expect(remote.requests.find((request) => request.method === "session/load")?.params).toEqual({
      sessionId: handle!.sessionId,
      cwd: "/remote/workspace",
      mcpServers: [],
    });
    expect(remote.requests.slice(0, 3).map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
    ]);
  });

  test("rejects local filesystem and terminal callbacks unless explicitly enabled", async () => {
    const remote = await startRemoteAgent();
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    for (const [method, params] of [
      ["fs/read_text_file", { path: "/must-not-be-read" }],
      ["fs/write_text_file", { path: "/must-not-be-written", content: "no" }],
      ["terminal/create", { command: "must-not-be-executed" }],
    ] as const) {
      const response = await remote.request(method, { sessionId: session.id, ...params });
      expect(response.error?.code).toBe(-32601);
    }
    await session.close();
  });

  test("fails an in-flight prompt when the remote connection is lost", async () => {
    const remote = await startRemoteAgent({ prompt: (socket) => socket.terminate() });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await expect(session.run("disconnect")).rejects.toThrow("Remote ACP WebSocket closed");
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
    await session.close();
  });

  test("keeps cancellation on the ACP connection", async () => {
    const remote = await startRemoteAgent({ prompt() {} });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    await session.startTurn("wait");
    await session.interrupt();
    await vi.waitFor(() => {
      expect(remote.requests).toContainEqual(expect.objectContaining({ method: "session/cancel" }));
    });
    await session.close();
  });

  test("fails an in-flight model change when the connection is lost", async () => {
    const remote = await startRemoteAgent({ disconnectOn: "session/set_model" });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    await expect(session.setModel("remote-model")).rejects.toThrow("Remote ACP WebSocket closed");
    await session.close();
  });

  test.each([
    { name: "binary", frame: Buffer.from("invalid"), error: "binary WebSocket frame" },
    {
      name: "malformed JSON",
      frame: "{private:do-not-log}",
      error: "invalid JSON-RPC WebSocket frame",
    },
    { name: "JSON-RPC batch", frame: "[]", error: "invalid JSON-RPC WebSocket frame" },
  ])("fails and cleans up a $name frame", async ({ frame, error }) => {
    const remote = await startRemoteAgent({ prompt: (socket) => socket.send(frame) });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
    });
    const session = await client.createSession({ provider: "acp", cwd: tmpdir() });
    await expect(session.run("bad frame")).rejects.toThrow(error);
    await session.close();
    await vi.waitFor(() => expect(remote.sockets.size).toBe(0));
  });

  test("does not open a connection when the configured bearer token is missing", async () => {
    const remote = await startRemoteAgent();
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: {
        type: "websocket",
        url: remote.url,
        bearerTokenEnv: "PASEO_TEST_MISSING_REMOTE_ACP_TOKEN",
      },
    });
    await expect(client.createSession({ provider: "acp", cwd: tmpdir() })).rejects.toThrow(
      "PASEO_TEST_MISSING_REMOTE_ACP_TOKEN",
    );
    expect(remote.headers).toHaveLength(0);
  });

  test.each([
    {
      methodId: "unknown",
      authMethods: [{ id: "oauth", name: "OAuth" }],
      error: "was not advertised",
    },
    {
      methodId: "terminal-login",
      authMethods: [{ id: "terminal-login", name: "Terminal", type: "terminal" as const }],
      error: "uses 'terminal' authentication",
    },
  ])("rejects unsupported auth selection $methodId", async ({ methodId, authMethods, error }) => {
    const remote = await startRemoteAgent({ authMethods });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
      authMethodId: methodId,
    });
    await expect(client.createSession({ provider: "acp", cwd: tmpdir() })).rejects.toThrow(error);
    expect(remote.requests.map((request) => request.method)).toEqual(["initialize"]);
    await vi.waitFor(() => expect(remote.sockets.size).toBe(0));
  });

  test("diagnostics report remote phases without disclosing credentials", async () => {
    const remote = await startRemoteAgent();
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      providerId: "remote-agent",
      label: "Remote agent",
      transport: {
        type: "websocket",
        url: `${remote.url}?private=do-not-log`,
        headers: { Authorization: "Bearer do-not-log" },
      },
      diagnosticPhaseTimeoutMs: 1_000,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain("Transport: WebSocket");
    expect(diagnostic).toContain("ACP connect: ok");
    expect(diagnostic).toContain("ACP initialize: ok");
    expect(diagnostic).toContain("ACP session/new: ok");
    expect(diagnostic).toContain("ACP cleanup: ok");
    expect(diagnostic).not.toContain("do-not-log");
    expect(diagnostic).not.toContain("Launcher binary");
  });

  test("does not create a session when agent authentication fails", async () => {
    const remote = await startRemoteAgent({ rejectAuth: true });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
      authMethodId: "oauth",
    });
    await expect(client.createSession({ provider: "acp", cwd: tmpdir() })).rejects.toThrow(
      "Sign-in rejected",
    );
    expect(remote.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
    ]);
    await vi.waitFor(() => expect(remote.sockets.size).toBe(0));
  });

  test("reports rejected WebSocket authentication without exposing the token", async () => {
    const remote = await startRemoteAgent({ bearerToken: "correct-token" });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: {
        type: "websocket",
        url: remote.url,
        headers: { Authorization: "Bearer wrong-private-token" },
      },
      diagnosticPhaseTimeoutMs: 1_000,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain("ACP connect: error:");
    expect(diagnostic).not.toContain("wrong-private-token");
    expect(remote.requests).toEqual([]);
  });

  test("cleans up when remote initialization times out", async () => {
    const remote = await startRemoteAgent({ ignoreInitialize: true });
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      transport: { type: "websocket", url: remote.url },
      diagnosticPhaseTimeoutMs: 50,
    });
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain("ACP initialize: error: ACP initialize timed out after 50ms");
    expect(diagnostic).toContain("ACP cleanup: ok");
    await vi.waitFor(() => expect(remote.sockets.size).toBe(0));
  });
});
