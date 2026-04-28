import type { Readable, Writable } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * MCP `Transport` implemented on top of pre-existing stdio streams.
 *
 * The SDK's built-in `StdioClientTransport` also spawns the child process.
 * We already own the process lifecycle via `CrgProcessManager`, so this
 * transport takes an externally-owned `stdout` (Readable) / `stdin`
 * (Writable) pair and wires MCP framing over them without touching spawn.
 *
 * Framing is newline-delimited JSON, per the MCP stdio profile.
 */
export class StdioStreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly stdout: Readable;
  private readonly stdin: Writable;
  private buffer = "";
  private started = false;
  private closed = false;
  private readonly onStdoutData: (chunk: Buffer | string) => void;
  private readonly onStdoutClose: () => void;
  private readonly onStdoutError: (err: Error) => void;
  private readonly onStdinError: (err: Error) => void;

  constructor(stdout: Readable, stdin: Writable) {
    this.stdout = stdout;
    this.stdin = stdin;
    this.onStdoutData = (chunk) => this.onData(chunk);
    this.onStdoutClose = () => this.onStreamClose();
    this.onStdoutError = (err) => this.emitError(err);
    this.onStdinError = (err) => this.emitError(err);
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("StdioStreamTransport already started");
    }
    this.started = true;
    this.stdout.on("data", this.onStdoutData);
    this.stdout.on("close", this.onStdoutClose);
    this.stdout.on("error", this.onStdoutError);
    this.stdin.on("error", this.onStdinError);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) {
      throw new Error("StdioStreamTransport is closed");
    }
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.stdin.write(payload, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdout.off("data", this.onStdoutData);
    this.stdout.off("close", this.onStdoutClose);
    this.stdout.off("error", this.onStdoutError);
    this.stdin.off("error", this.onStdinError);
    this.onclose?.();
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.flushLines();
  }

  private flushLines(): void {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const raw = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (raw.length === 0) continue;
      try {
        const message = JSON.parse(raw) as JSONRPCMessage;
        this.onmessage?.(message);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(`Failed to parse MCP line: ${raw}`));
      }
    }
  }

  private onStreamClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  private emitError(err: Error): void {
    this.onerror?.(err);
  }
}
