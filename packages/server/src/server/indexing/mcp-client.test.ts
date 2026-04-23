import { describe, it, expect } from "vitest";
import pino from "pino";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { CrgMcpClient, type CrgMcpBackend } from "./mcp-client.js";

class FakeBackend implements CrgMcpBackend {
  connected = false;
  closed = false;
  tools: Array<{ name: string; description?: string }> = [
    { name: "blast_radius", description: "a" },
    { name: "minimal_context", description: "b" },
  ];
  callResult: unknown = { ok: true };
  callHistory: Array<{ name: string; args?: Record<string, unknown> }> = [];
  connectImpl: (transport: Transport) => Promise<void> = async () => undefined;
  listToolsImpl?: () => Promise<{ tools: Array<{ name: string; description?: string }> }>;

  async connect(transport: Transport): Promise<void> {
    await this.connectImpl(transport);
    this.connected = true;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
  async listTools() {
    if (this.listToolsImpl) return this.listToolsImpl();
    return { tools: this.tools };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.callHistory.push({ name: params.name, args: params.arguments });
    return this.callResult;
  }
}

const noopTransport: Transport = {
  async start() {},
  async send() {},
  async close() {},
};

function makeClient(backend = new FakeBackend()) {
  const client = new CrgMcpClient({
    logger: pino({ enabled: false }),
    backendFactory: () => backend,
  });
  return { client, backend };
}

describe("CrgMcpClient.connect", () => {
  it("transitions disconnected → connecting → connected and caches tools", async () => {
    const { client, backend } = makeClient();
    const states: string[] = [];
    client.onConnectionState((s) => states.push(s.phase));
    await client.connect(noopTransport);
    expect(states).toEqual(["connecting", "connected"]);
    expect(client.isConnected()).toBe(true);
    expect(backend.connected).toBe(true);
    expect(client.getCachedTools().map((t) => t.name)).toEqual([
      "crg_blast_radius",
      "crg_minimal_context",
    ]);
  });

  it("marks state=failed when backend.connect throws", async () => {
    const backend = new FakeBackend();
    backend.connectImpl = async () => {
      throw new Error("boom");
    };
    const { client } = makeClient(backend);
    await expect(client.connect(noopTransport)).rejects.toThrow(/boom/);
    expect(client.getConnectionState().phase).toBe("failed");
    expect(client.getConnectionState().error).toBe("boom");
  });

  it("rejects when already connecting (reentrancy)", async () => {
    const backend = new FakeBackend();
    let resolve: (() => void) | null = null;
    backend.connectImpl = () =>
      new Promise((res) => {
        resolve = res;
      });
    const { client } = makeClient(backend);
    const first = client.connect(noopTransport);
    await expect(client.connect(noopTransport)).rejects.toThrow(/connecting/i);
    resolve?.();
    await first;
  });

  it("disconnects any previous backend before reconnecting", async () => {
    const backend1 = new FakeBackend();
    const backend2 = new FakeBackend();
    let callIndex = 0;
    const client = new CrgMcpClient({
      logger: pino({ enabled: false }),
      backendFactory: () => (callIndex++ === 0 ? backend1 : backend2),
    });
    await client.connect(noopTransport);
    await client.connect(noopTransport);
    expect(backend1.closed).toBe(true);
    expect(backend2.connected).toBe(true);
  });
});

describe("CrgMcpClient.disconnect", () => {
  it("closes backend, clears cache, transitions to disconnected", async () => {
    const { client, backend } = makeClient();
    await client.connect(noopTransport);
    await client.disconnect();
    expect(backend.closed).toBe(true);
    expect(client.isConnected()).toBe(false);
    expect(client.getCachedTools()).toEqual([]);
  });

  it("is idempotent when not connected", async () => {
    const { client } = makeClient();
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("swallows backend close errors but still resets state", async () => {
    const backend = new FakeBackend();
    const { client } = makeClient(backend);
    await client.connect(noopTransport);
    backend.close = async () => {
      throw new Error("close-threw");
    };
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(false);
  });
});

describe("CrgMcpClient.refreshTools", () => {
  it("requires a connection", async () => {
    const { client } = makeClient();
    await expect(client.refreshTools()).rejects.toThrow(/not connected/i);
  });

  it("notifies tools-changed listeners", async () => {
    const { client, backend } = makeClient();
    const snapshots: number[] = [];
    client.onToolsChanged((tools) => snapshots.push(tools.length));
    await client.connect(noopTransport);
    expect(snapshots).toEqual([2]); // initial refresh on connect
    backend.tools = [...backend.tools, { name: "impact_analysis", description: "c" }];
    await client.refreshTools();
    expect(snapshots).toEqual([2, 3]);
  });

  it("namespaces the tool list", async () => {
    const { client } = makeClient();
    await client.connect(noopTransport);
    expect(client.getCachedTools().every((t) => t.name.startsWith("crg_"))).toBe(true);
  });
});

describe("CrgMcpClient.callTool", () => {
  it("strips the namespace before forwarding", async () => {
    const { client, backend } = makeClient();
    await client.connect(noopTransport);
    await client.callTool("crg_blast_radius", { target: "foo" });
    expect(backend.callHistory).toEqual([{ name: "blast_radius", args: { target: "foo" } }]);
  });

  it("passes raw names through unchanged", async () => {
    const { client, backend } = makeClient();
    await client.connect(noopTransport);
    await client.callTool("blast_radius");
    expect(backend.callHistory[0]?.name).toBe("blast_radius");
  });

  it("returns the backend result", async () => {
    const backend = new FakeBackend();
    backend.callResult = { content: "impact" };
    const { client } = makeClient(backend);
    await client.connect(noopTransport);
    const result = await client.callTool("crg_impact_analysis");
    expect(result).toEqual({ content: "impact" });
  });

  it("rejects when not connected", async () => {
    const { client } = makeClient();
    await expect(client.callTool("crg_blast_radius")).rejects.toThrow(/not connected/i);
  });
});

describe("CrgMcpClient listeners", () => {
  it("unsubscribe detaches listeners", async () => {
    const { client } = makeClient();
    const states: string[] = [];
    const unsubscribe = client.onConnectionState((s) => states.push(s.phase));
    unsubscribe();
    await client.connect(noopTransport);
    expect(states).toEqual([]);
  });

  it("does not propagate listener exceptions", async () => {
    const { client } = makeClient();
    client.onConnectionState(() => {
      throw new Error("bad listener");
    });
    await expect(client.connect(noopTransport)).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
  });
});
