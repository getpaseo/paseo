import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter, PassThrough } from "node:stream";
import pino from "pino";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { IndexingRuntime } from "./runtime.js";
import type { CrgProcessManager, CrgProcessState } from "./process-manager.js";
import { CrgMcpClient, type CrgMcpBackend } from "./mcp-client.js";

class FakeProcessManager extends EventEmitter {
  failuresReset = 0;
  currentState: CrgProcessState = { phase: "stopped", restartCount: 0 };
  streams: { stdout: NodeJS.ReadableStream; stdin: NodeJS.WritableStream } | null = null;
  getState(): CrgProcessState {
    return { ...this.currentState };
  }
  isRunning(): boolean {
    return this.currentState.phase === "running";
  }
  getChildStreams() {
    return this.streams;
  }
  resetFailures() {
    this.failuresReset += 1;
  }
  transition(next: CrgProcessState) {
    this.currentState = next;
    this.emit("state", next);
  }
  asManager(): CrgProcessManager {
    return this as unknown as CrgProcessManager;
  }
}

function makeStreams() {
  return {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
  };
}

class FakeBackend implements CrgMcpBackend {
  connected = false;
  closed = false;
  connectImpl: (transport: Transport) => Promise<void> = async () => undefined;
  async connect(transport: Transport) {
    await this.connectImpl(transport);
    this.connected = true;
  }
  async close() {
    this.closed = true;
    this.connected = false;
  }
  async listTools() {
    return { tools: [] };
  }
  async callTool() {
    return { ok: true };
  }
}

function makeClient(backend: FakeBackend) {
  return new CrgMcpClient({
    logger: pino({ enabled: false }),
    backendFactory: () => backend,
  });
}

describe("IndexingRuntime", () => {
  let pm: FakeProcessManager;
  let backend: FakeBackend;
  let client: CrgMcpClient;
  let transportsCreated: number;
  let runtime: IndexingRuntime;

  beforeEach(() => {
    pm = new FakeProcessManager();
    backend = new FakeBackend();
    client = makeClient(backend);
    transportsCreated = 0;
    const noopTransport: Transport = {
      async start() {},
      async send() {},
      async close() {},
    };
    runtime = new IndexingRuntime({
      logger: pino({ enabled: false }),
      processManager: pm.asManager(),
      mcpClient: client,
      transportFactory: () => {
        transportsCreated += 1;
        return noopTransport;
      },
    });
  });

  it("connects the MCP client when process enters running", async () => {
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    // Wait for the in-flight connect to settle
    await new Promise((r) => setImmediate(r));
    expect(transportsCreated).toBe(1);
    expect(client.isConnected()).toBe(true);
  });

  it("disconnects the MCP client when process stops", async () => {
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    await new Promise((r) => setImmediate(r));
    pm.transition({ phase: "stopped", restartCount: 0 });
    await new Promise((r) => setImmediate(r));
    expect(client.isConnected()).toBe(false);
    expect(backend.closed).toBe(true);
  });

  it("disconnects on restarting phase too", async () => {
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    await new Promise((r) => setImmediate(r));
    pm.transition({ phase: "restarting", restartCount: 1 });
    await new Promise((r) => setImmediate(r));
    expect(client.isConnected()).toBe(false);
  });

  it("resets process manager failure counter after MCP handshake", async () => {
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    await new Promise((r) => setImmediate(r));
    expect(pm.failuresReset).toBeGreaterThanOrEqual(1);
  });

  it("does not reset failures when MCP connect fails", async () => {
    backend.connectImpl = async () => {
      throw new Error("bad handshake");
    };
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    await new Promise((r) => setImmediate(r));
    expect(pm.failuresReset).toBe(0);
    expect(client.isConnected()).toBe(false);
  });

  it("dedupes overlapping connect attempts", async () => {
    let resolveConnect: (() => void) | null = null;
    backend.connectImpl = () =>
      new Promise((res) => {
        resolveConnect = res;
      });
    pm.streams = makeStreams();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    // Same running event again while first connect in flight — should not start another
    pm.transition({ phase: "running", pid: 2, restartCount: 0, startedAt: Date.now() });
    expect(transportsCreated).toBe(1);
    resolveConnect?.();
    await new Promise((r) => setImmediate(r));
  });

  it("dispose detaches listeners", () => {
    runtime.dispose();
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    expect(transportsCreated).toBe(0);
  });

  it("warns (no crash) when process reports running but has no streams", async () => {
    pm.streams = null;
    pm.transition({ phase: "running", pid: 1, restartCount: 0, startedAt: Date.now() });
    await new Promise((r) => setImmediate(r));
    expect(transportsCreated).toBe(0);
    expect(client.isConnected()).toBe(false);
  });
});
