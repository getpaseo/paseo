import { WebSocket } from "ws";

interface WebSocketLike {
  readyState: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  binaryType?: string;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener?: (event: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (event: string, listener: (event: unknown) => void) => void;
  onopen?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
}

export type NodeWebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

export function createNodeWebSocketFactory(): NodeWebSocketFactory {
  return (url: string, options?: { headers?: Record<string, string> }) =>
    new WebSocket(url, { headers: options?.headers }) as unknown as WebSocketLike;
}
