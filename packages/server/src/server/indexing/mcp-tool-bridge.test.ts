import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";

import { registerCrgToolsOnServer, type RegisterableMcpServer } from "./mcp-tool-bridge.js";
import type { CrgMcpClient } from "./mcp-client.js";
import type { CrgToolManifest } from "./tool-filter.js";
import { normalizeIndexingState, type IndexingState } from "./types.js";

interface RegisteredTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  handler: (args: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function makeFakeServer(): RegisterableMcpServer & { registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  return {
    registered,
    registerTool(name, config, handler) {
      registered.push({ name, config, handler });
    },
  };
}

class FakeClient {
  connected = true;
  tools: CrgToolManifest[] = [
    { name: "crg_blast_radius", description: "Blast radius analysis" },
    { name: "crg_minimal_context", description: "Minimal context" },
  ];
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: "text", text: "default response" }],
  });
  callHistory: Array<{ name: string; args?: Record<string, unknown> }> = [];
  isConnected() {
    return this.connected;
  }
  getCachedTools(): CrgToolManifest[] {
    return [...this.tools];
  }
  async callToolImpl(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.callHistory.push({ name, args });
    return this.callTool(name, args);
  }
  asClient(): CrgMcpClient {
    const self = this;
    return {
      isConnected: () => self.isConnected(),
      getCachedTools: () => self.getCachedTools(),
      callTool: (name: string, args?: Record<string, unknown>) => self.callToolImpl(name, args),
    } as unknown as CrgMcpClient;
  }
}

function enabledState(overrides: Partial<IndexingState> = {}): IndexingState {
  return normalizeIndexingState({ enabled: true, ...overrides });
}

function makeBridge(opts: {
  agentId?: string | null;
  stateResolver?: () => Promise<IndexingState | null> | IndexingState | null;
  client?: FakeClient;
}) {
  const fakeClient = opts.client ?? new FakeClient();
  const server = makeFakeServer();
  const result = registerCrgToolsOnServer({
    logger: pino({ enabled: false }),
    server,
    mcpClient: fakeClient.asClient(),
    agentId: opts.agentId === undefined ? "claude-code" : opts.agentId,
    getIndexingState: opts.stateResolver ?? (() => enabledState()),
  });
  return { server, fakeClient, result };
}

describe("registerCrgToolsOnServer registration", () => {
  it("registers every cached tool under its namespaced name", () => {
    const { server, result } = makeBridge({});
    expect(result.registered).toBe(2);
    expect(server.registered.map((r) => r.name)).toEqual([
      "crg_blast_radius",
      "crg_minimal_context",
    ]);
  });

  it("skips when no agentId", () => {
    const { server, result } = makeBridge({ agentId: null });
    expect(result.registered).toBe(0);
    expect(result.skippedReason).toMatch(/agentId/);
    expect(server.registered).toHaveLength(0);
  });

  it("skips when MCP client not connected", () => {
    const client = new FakeClient();
    client.connected = false;
    const { server, result } = makeBridge({ client });
    expect(result.registered).toBe(0);
    expect(result.skippedReason).toMatch(/not connected/);
    expect(server.registered).toHaveLength(0);
  });

  it("skips when crg cache is empty", () => {
    const client = new FakeClient();
    client.tools = [];
    const { result } = makeBridge({ client });
    expect(result.registered).toBe(0);
    expect(result.skippedReason).toMatch(/empty/);
  });

  it("uses tool description as fallback title/description", () => {
    const { server } = makeBridge({});
    expect(server.registered[0]?.config.description).toBe("Blast radius analysis");
    expect(server.registered[0]?.config.title).toBe("blast radius");
  });

  it("continues registering after a single-tool failure", () => {
    const server: RegisterableMcpServer & { registered: RegisteredTool[] } = {
      registered: [],
      registerTool(name, config, handler) {
        if (name === "crg_blast_radius") throw new Error("boom");
        this.registered.push({ name, config, handler });
      },
    };
    const fakeClient = new FakeClient();
    const result = registerCrgToolsOnServer({
      logger: pino({ enabled: false }),
      server,
      mcpClient: fakeClient.asClient(),
      agentId: "claude-code",
      getIndexingState: () => enabledState(),
    });
    expect(result.registered).toBe(1);
    expect(server.registered.map((r) => r.name)).toEqual(["crg_minimal_context"]);
  });
});

describe("registerCrgToolsOnServer handler authorization", () => {
  let fakeClient: FakeClient;

  beforeEach(() => {
    fakeClient = new FakeClient();
  });

  it("forwards calls via mcpClient and normalizes text content", async () => {
    fakeClient.callTool = async () => ({
      content: [{ type: "text", text: "result body" }],
    });
    const { server } = makeBridge({ client: fakeClient });
    const handler = server.registered[0]?.handler;
    if (!handler) throw new Error("no handler");
    const response = await handler({ target: "foo" });
    expect(response.content[0]?.text).toBe("result body");
    expect(fakeClient.callHistory[0]).toEqual({
      name: "crg_blast_radius",
      args: { target: "foo" },
    });
  });

  it("returns isError when state resolver returns null", async () => {
    const { server } = makeBridge({ client: fakeClient, stateResolver: () => null });
    const handler = server.registered[0]?.handler;
    const response = await handler!({});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/not configured/);
  });

  it("denies call when state has indexing disabled mid-session", async () => {
    let state: IndexingState = enabledState();
    const { server } = makeBridge({ client: fakeClient, stateResolver: () => state });
    state = normalizeIndexingState({ enabled: false });
    const handler = server.registered[0]?.handler;
    const response = await handler!({});
    expect(response.isError).toBe(true);
    expect(fakeClient.callHistory).toHaveLength(0);
  });

  it("denies call when per-tool list excludes the tool", async () => {
    const state = enabledState({
      exposeTo: {
        "claude-code": { enabled: true, enabledTools: ["crg_minimal_context"] },
      },
    });
    const { server } = makeBridge({ client: fakeClient, stateResolver: () => state });
    const handler = server.registered.find((t) => t.name === "crg_blast_radius")?.handler;
    const response = await handler!({});
    expect(response.isError).toBe(true);
    expect(fakeClient.callHistory).toHaveLength(0);
  });

  it("returns error when connection drops after registration", async () => {
    const { server } = makeBridge({ client: fakeClient });
    fakeClient.connected = false;
    const handler = server.registered[0]?.handler;
    const response = await handler!({});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/not connected/);
  });

  it("propagates tool call exceptions as isError text", async () => {
    fakeClient.callTool = async () => {
      throw new Error("crg crashed");
    };
    const { server } = makeBridge({ client: fakeClient });
    const handler = server.registered[0]?.handler;
    const response = await handler!({});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/crg crashed/);
  });

  it("treats non-object args as undefined arguments", async () => {
    const { server } = makeBridge({ client: fakeClient });
    await server.registered[0]?.handler("not an object");
    expect(fakeClient.callHistory[0]?.args).toBeUndefined();
  });

  it("stringifies non-standard backend results", async () => {
    fakeClient.callTool = async () => 42;
    const { server } = makeBridge({ client: fakeClient });
    const response = await server.registered[0]!.handler({});
    expect(response.content[0]?.text).toBe("42");
  });

  it("supports an async state resolver", async () => {
    const { server } = makeBridge({
      client: fakeClient,
      stateResolver: () =>
        new Promise<IndexingState | null>((resolve) =>
          setTimeout(() => resolve(enabledState()), 5),
        ) as unknown as IndexingState | null,
    });
    const handler = server.registered[0]?.handler;
    const response = await handler!({});
    expect(response.isError).toBeFalsy();
    expect(fakeClient.callHistory).toHaveLength(1);
  });
});
