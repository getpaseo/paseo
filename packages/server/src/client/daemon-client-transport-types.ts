export interface DaemonTransport {
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (handler: (data: unknown) => void) => () => void;
  onOpen: (handler: () => void) => () => void;
  onClose: (handler: (event?: unknown) => void) => () => void;
  onError: (handler: (event?: unknown) => void) => () => void;
}

export type DaemonTransportFactory = (options: {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}) => DaemonTransport;

export type WebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
) => WebSocketLike;

export interface WebSocketLike {
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

export interface TransportLogger {
  warn(obj: object, msg?: string): void;
}
