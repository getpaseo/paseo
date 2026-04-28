import WebSocket from "ws";

type WebSocketLike = {
  readyState: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  binaryType?: string;
  on?: (event: string, listener: (...args: any[]) => void) => void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
  addEventListener?: (event: string, listener: (event: any) => void) => void;
  removeEventListener?: (event: string, listener: (event: any) => void) => void;
  onopen?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
};

export type NodeWebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

export function createNodeWebSocketFactory(): NodeWebSocketFactory {
  return (url: string, options?: { headers?: Record<string, string> }) =>
    new WebSocket(url, { headers: options?.headers }) as unknown as WebSocketLike;
}
