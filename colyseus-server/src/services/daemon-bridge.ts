import WebSocket from "ws";
import { nanoid } from "nanoid";

export type AgentStatusCallback = (status: "idle" | "running" | "waiting_input") => void;

/**
 * Connects to a daemon's WebSocket as a client to:
 * 1. Forward FIFO messages to the agent
 * 2. Listen to agent status changes (idle, running, waiting_input)
 */
export class DaemonBridge {
  private ws: WebSocket | null = null;
  private daemonUrl: string;
  private sessionId: string;
  private clientId: string;
  private statusCallback: AgentStatusCallback | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(daemonUrl: string, sessionId: string) {
    this.daemonUrl = daemonUrl;
    this.sessionId = sessionId;
    this.clientId = `colyseus-bridge-${sessionId}-${nanoid(6)}`;
  }

  onAgentStatus(callback: AgentStatusCallback): void {
    this.statusCallback = callback;
  }

  connect(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.daemonUrl);

      this.ws.on("open", () => {
        this.connected = true;
        // Send hello to establish session
        this.ws?.send(
          JSON.stringify({
            type: "hello",
            clientId: this.clientId,
            appVersion: "colyseus-bridge/1.0",
          }),
        );
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session" && msg.message) {
            this.handleAgentEvent(msg.message);
          }
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.ws = null;
        // Attempt reconnect after 3s
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      });

      this.ws.on("error", () => {
        // Error triggers close
      });
    } catch {
      // Connection failed — will retry on close
    }
  }

  private handleAgentEvent(event: { type: string; [key: string]: unknown }): void {
    if (!this.statusCallback) return;

    switch (event.type) {
      case "agent_thinking":
      case "agent_working":
      case "agent_stream_event":
        this.statusCallback("running");
        break;
      case "stream_finished":
      case "agent_snapshot":
        this.statusCallback("idle");
        break;
      case "attention_required":
        this.statusCallback("waiting_input");
        break;
    }
  }

  /**
   * Forward a user message to the agent via the daemon's existing RPC.
   */
  async sendMessage(content: string, userId: string): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error("Daemon bridge not connected");
    }

    return new Promise((resolve, reject) => {
      const requestId = nanoid();
      const timeout = setTimeout(() => reject(new Error("Message send timeout")), 30_000);

      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (
            msg.type === "session" &&
            msg.message?.type === "send_agent_message_response" &&
            msg.message?.requestId === requestId
          ) {
            clearTimeout(timeout);
            this.ws?.off("message", handler);
            resolve();
          }
        } catch {
          // Ignore
        }
      };

      this.ws!.on("message", handler);

      this.ws!.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "send_agent_message_request",
            requestId,
            message: content,
            agentId: this.sessionId,
            metadata: { sharedBy: userId },
          },
        }),
      );
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
