import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "pino";

import { namespaceCrgTools, type CrgToolManifest } from "./tool-filter.js";

/**
 * Thin wrapper around the MCP SDK `Client` tuned to the crg subprocess.
 *
 * Responsibilities:
 *   - Connect an injected `Transport` (we use `StdioStreamTransport` over
 *     `CrgProcessManager`'s streams; tests inject an in-memory transport).
 *   - Fetch and cache the crg tool manifest (namespaced with `crg_`).
 *   - Route `callTool` by stripping the namespace when forwarding.
 *   - Expose connection status so the process manager can learn when the
 *     MCP handshake has actually succeeded (and so reset its failure counter).
 *
 * Lifecycle integration with `CrgProcessManager` lands in PR3b.
 */

export type CrgMcpConnectionPhase = "disconnected" | "connecting" | "connected" | "failed";

export interface CrgMcpConnectionState {
  phase: CrgMcpConnectionPhase;
  error?: string;
  connectedAt?: number;
}

/**
 * Minimal subset of the SDK `Client` that we rely on. Accepting this
 * interface (instead of the concrete class) lets tests inject a fake client
 * without spinning up a real MCP session.
 */
export interface CrgMcpBackend {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    }>;
  }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

export interface CrgMcpClientDeps {
  logger: Logger;
  backendFactory?: () => CrgMcpBackend;
  clientInfo?: { name: string; version: string };
}

const DEFAULT_CLIENT_INFO = { name: "hubcode-crg-proxy", version: "0.1.0" };

export class CrgMcpClient {
  private readonly logger: Logger;
  private readonly backendFactory: () => CrgMcpBackend;
  private backend: CrgMcpBackend | null = null;
  private cachedTools: CrgToolManifest[] | null = null;
  private state: CrgMcpConnectionState = { phase: "disconnected" };
  private readonly stateListeners = new Set<(s: CrgMcpConnectionState) => void>();
  private readonly toolsListeners = new Set<(tools: CrgToolManifest[]) => void>();

  constructor(deps: CrgMcpClientDeps) {
    this.logger = deps.logger.child({ module: "crg-mcp-client" });
    const clientInfo = deps.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.backendFactory =
      deps.backendFactory ?? (() => new Client(clientInfo) as unknown as CrgMcpBackend);
  }

  getConnectionState(): CrgMcpConnectionState {
    return { ...this.state };
  }

  isConnected(): boolean {
    return this.state.phase === "connected";
  }

  getCachedTools(): CrgToolManifest[] {
    return this.cachedTools ? [...this.cachedTools] : [];
  }

  onConnectionState(listener: (state: CrgMcpConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onToolsChanged(listener: (tools: CrgToolManifest[]) => void): () => void {
    this.toolsListeners.add(listener);
    return () => {
      this.toolsListeners.delete(listener);
    };
  }

  /**
   * Connect an MCP transport, perform handshake, and refresh the tool cache.
   * If already connected, closes the previous connection first.
   */
  async connect(transport: Transport): Promise<void> {
    if (this.state.phase === "connecting") {
      throw new Error("CrgMcpClient already connecting");
    }
    if (this.backend) {
      await this.disconnect().catch(() => undefined);
    }
    this.transition({ phase: "connecting" });
    try {
      const backend = this.backendFactory();
      await backend.connect(transport);
      this.backend = backend;
      this.transition({ phase: "connected", connectedAt: Date.now() });
      await this.refreshTools();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "crg MCP connect failed");
      this.transition({ phase: "failed", error: message });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.backend) {
      this.transition({ phase: "disconnected" });
      return;
    }
    const backend = this.backend;
    this.backend = null;
    try {
      await backend.close();
    } catch (err) {
      this.logger.warn({ err }, "crg MCP disconnect threw");
    }
    this.cachedTools = null;
    this.transition({ phase: "disconnected" });
  }

  async refreshTools(): Promise<CrgToolManifest[]> {
    if (!this.backend) {
      throw new Error("CrgMcpClient not connected");
    }
    const response = await this.backend.listTools();
    const rawTools: CrgToolManifest[] = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
    const namespaced = namespaceCrgTools(rawTools);
    this.cachedTools = namespaced;
    for (const listener of this.toolsListeners) {
      try {
        listener([...namespaced]);
      } catch (err) {
        this.logger.warn({ err }, "tools-changed listener threw");
      }
    }
    return namespaced;
  }

  /**
   * Invoke a namespaced tool (strips prefix before forwarding).
   */
  async callTool(namespacedName: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.backend) {
      throw new Error("CrgMcpClient not connected");
    }
    const { CRG_TOOL_PREFIX } = await import("./tool-filter.js");
    const rawName = namespacedName.startsWith(CRG_TOOL_PREFIX)
      ? namespacedName.slice(CRG_TOOL_PREFIX.length)
      : namespacedName;
    return this.backend.callTool({ name: rawName, arguments: args });
  }

  private transition(next: CrgMcpConnectionState): void {
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener({ ...next });
      } catch (err) {
        this.logger.warn({ err }, "state listener threw");
      }
    }
  }
}
