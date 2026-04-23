import type { Logger } from "pino";

import type { CrgProcessManager, CrgProcessState } from "./process-manager.js";
import type { CrgMcpClient, CrgMcpConnectionState } from "./mcp-client.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioStreamTransport } from "./stdio-stream-transport.js";

/**
 * Glues `CrgProcessManager` + `CrgMcpClient` together:
 *
 *  1. When the subprocess transitions to `running`, a `StdioStreamTransport`
 *     is built over the child's streams and handed to the MCP client.
 *  2. When the subprocess stops, the client is disconnected.
 *  3. When the client successfully connects (MCP handshake OK), the
 *     process manager's failure counter is reset — this is the "stable
 *     enough to count" signal that `CrgProcessManager.start()` deliberately
 *     doesn't have.
 *
 * Transport construction is injected so tests don't need real streams.
 */

export interface IndexingRuntimeDeps {
  logger: Logger;
  processManager: CrgProcessManager;
  mcpClient: CrgMcpClient;
  transportFactory?: (streams: {
    stdout: NodeJS.ReadableStream;
    stdin: NodeJS.WritableStream;
  }) => Transport;
}

function defaultTransportFactory(streams: {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
}): Transport {
  return new StdioStreamTransport(
    streams.stdout as unknown as import("node:stream").Readable,
    streams.stdin as unknown as import("node:stream").Writable,
  );
}

export class IndexingRuntime {
  private readonly logger: Logger;
  private readonly processManager: CrgProcessManager;
  private readonly mcpClient: CrgMcpClient;
  private readonly transportFactory: NonNullable<IndexingRuntimeDeps["transportFactory"]>;
  private readonly unsubscribeProcessState: () => void;
  private readonly unsubscribeConnectionState: () => void;
  private connectInFlight: Promise<void> | null = null;

  constructor(deps: IndexingRuntimeDeps) {
    this.logger = deps.logger.child({ module: "indexing-runtime" });
    this.processManager = deps.processManager;
    this.mcpClient = deps.mcpClient;
    this.transportFactory = deps.transportFactory ?? defaultTransportFactory;
    const stateListener = (state: CrgProcessState) => this.onProcessStateChange(state);
    this.processManager.on("state", stateListener);
    this.unsubscribeProcessState = () => {
      this.processManager.off("state", stateListener);
    };
    this.unsubscribeConnectionState = this.mcpClient.onConnectionState((s) =>
      this.onMcpConnectionStateChange(s),
    );
  }

  /**
   * Tear down listeners. The underlying process manager / MCP client are
   * owned by the caller and not stopped here.
   */
  dispose(): void {
    this.unsubscribeProcessState();
    this.unsubscribeConnectionState();
  }

  private onProcessStateChange(state: CrgProcessState): void {
    if (state.phase === "running") {
      void this.tryConnect();
      return;
    }
    if (state.phase === "stopped" || state.phase === "restarting" || state.phase === "failed") {
      if (this.mcpClient.isConnected()) {
        void this.mcpClient.disconnect().catch((err) => {
          this.logger.warn({ err }, "disconnect after process state change failed");
        });
      }
    }
  }

  private async tryConnect(): Promise<void> {
    if (this.connectInFlight) return this.connectInFlight;
    const streams = this.processManager.getChildStreams();
    if (!streams) {
      this.logger.warn("process reports running but exposes no streams");
      return;
    }
    const transport = this.transportFactory(streams);
    this.connectInFlight = this.mcpClient
      .connect(transport)
      .catch((err) => {
        this.logger.warn({ err }, "MCP connect failed; relying on process manager to restart");
      })
      .finally(() => {
        this.connectInFlight = null;
      });
    return this.connectInFlight;
  }

  private onMcpConnectionStateChange(state: CrgMcpConnectionState): void {
    if (state.phase === "connected") {
      this.processManager.resetFailures();
      this.logger.debug("MCP handshake succeeded; reset crg failure counter");
    }
  }
}
