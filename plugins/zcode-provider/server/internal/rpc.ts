import {
  decodeFrame,
  encodeError,
  encodeRequest,
  encodeResponse,
  type ZCodeEventFrame,
  type ZCodeRequestFrame,
} from "./wire.js";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class ZCodeMethodNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZCodeMethodNotFoundError";
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof ZCodeMethodNotFoundError;
}

export class ZCodeRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Set<(event: ZCodeEventFrame) => void>();
  private readonly requestListeners = new Set<
    (request: ZCodeRequestFrame) => Promise<unknown> | unknown
  >();
  private closed = false;

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ZCode connection is closed"));
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(encodeRequest(id, method, params));
    });
  }

  onEvent(listener: (event: ZCodeEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * ZCode asks the host for permission with a reverse request, so the client
   * has to answer requests as well as make them. The handler's resolved value
   * is sent back as the response.
   */
  onRequest(listener: (request: ZCodeRequestFrame) => Promise<unknown> | unknown): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  private async handleRequest(frame: ZCodeRequestFrame): Promise<void> {
    for (const listener of this.requestListeners) {
      try {
        const result = await listener(frame);
        this.write(encodeResponse(frame.id, result));
        return;
      } catch (error) {
        this.write(
          encodeError(frame.id, -32603, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }
    this.write(encodeError(frame.id, -32601, `Unknown method: ${frame.method}`));
  }

  receive(line: string): void {
    const frame = decodeFrame(line);
    if (!frame) return;
    if (frame.kind === "event") {
      for (const listener of this.listeners) listener(frame.event);
      return;
    }
    if (frame.kind === "request") {
      void this.handleRequest(frame.request);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.kind === "error") {
      pending.reject(
        frame.code === -32601
          ? new ZCodeMethodNotFoundError(frame.message)
          : Object.assign(new Error(frame.message), { protocolCode: frame.code }),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("ZCode connection closed before the response arrived"));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  /** Overridden by the process layer to write a framed line to the child. */
  protected write(_line: string): void {
    throw new Error("ZCode RPC client has no output stream");
  }
}
