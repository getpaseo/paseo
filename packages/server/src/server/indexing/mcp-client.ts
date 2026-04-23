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
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
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
      // Populate the tool-name cache BEFORE announcing "connected" so that
      // listeners (runInitialReindex etc.) can safely call `callTool` and
      // have `resolveToolName` hit the cache. Otherwise there's a race where
      // the first call goes out with the unresolved name and crg replies
      // "Unknown tool".
      await this.refreshTools();
      this.transition({ phase: "connected", connectedAt: Date.now() });
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
   * Invoke a namespaced tool (strips prefix before forwarding). Optional
   * AbortSignal lets callers cancel long-running calls — the MCP SDK turns
   * the signal into a `notifications/cancelled` on the wire so crg can
   * release resources instead of running to completion in the background.
   */
  async callTool(
    namespacedName: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (!this.backend) {
      throw new Error("CrgMcpClient not connected");
    }
    const { CRG_TOOL_PREFIX } = await import("./tool-filter.js");
    const rawName = namespacedName.startsWith(CRG_TOOL_PREFIX)
      ? namespacedName.slice(CRG_TOOL_PREFIX.length)
      : namespacedName;
    const resolvedName = this.resolveToolName(rawName);
    if (resolvedName !== rawName) {
      this.logger.debug(
        { requested: rawName, resolved: resolvedName },
        "crg tool name resolved via cached manifest",
      );
    }
    return this.backend.callTool(
      { name: resolvedName, arguments: args },
      undefined,
      options ? { signal: options.signal } : undefined,
    );
  }

  /**
   * Resolve a caller-supplied bare tool name against the cached manifest so
   * we survive upstream renames. crg 2.3.2 introduced a `_tool` suffix on
   * every registered name (`build_or_update_graph` → `build_or_update_graph_tool`);
   * a naïve call with the old name gets "tool not found" and the daemon
   * hangs waiting for a response that never comes.
   *
   * Order of precedence:
   *   1. Exact name exists → pass through.
   *   2. `<name>_tool` exists → use it.
   *   3. Unique candidate ending in `_tool` whose base matches → use it.
   *   4. Otherwise, pass the original name (MCP will error; caller decides).
   */
  private resolveToolName(rawName: string): string {
    const tools = this.cachedTools;
    if (!tools || tools.length === 0) return rawName;
    const bareSet = new Set(tools.map((t) => this.stripNamespace(t.name)));
    if (bareSet.has(rawName)) return rawName;
    if (bareSet.has(`${rawName}_tool`)) return `${rawName}_tool`;
    return rawName;
  }

  private stripNamespace(name: string): string {
    // tool-filter namespaces as `crg_<raw>`. Strip for cache comparison.
    return name.startsWith("crg_") ? name.slice("crg_".length) : name;
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
