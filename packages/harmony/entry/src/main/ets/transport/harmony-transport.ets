/**
 * HarmonyOS WebSocket transport adapter for Paseo DaemonClient.
 *
 * Implements the `DaemonTransport` interface (from @getpaseo/client) using
 * @ohos.net.webSocket. Handles both JSON text frames (session messages) and
 * binary frames (terminal I/O).
 */

import webSocket from '@ohos.net.webSocket';
import type { DaemonTransport, TransportLogger } from '@getpaseo/client/internal/daemon-client-transport-types';

/** ReadyState constants matching the standard WebSocket spec. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface HarmonyTransportOptions {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
  logger?: TransportLogger;
}

// Explicit interfaces for ArkTS strict mode (no untyped object literals)
interface CloseEventData {
  code: number;
  reason: string;
}

interface ErrorEventData {
  message: string;
}

interface LoggerWarnData {
  err?: string;
  url?: string;
  code?: number;
  reason?: string;
}

/**
 * Creates a DaemonTransport backed by @ohos.net.webSocket.
 */
export function createHarmonyTransport(options: HarmonyTransportOptions): DaemonTransport {
  const url: string = options.url;
  const headers: Record<string, string> | undefined = options.headers;
  const protocols: string[] | undefined = options.protocols;
  const logger: TransportLogger | undefined = options.logger;

  const ws: webSocket.WebSocket = webSocket.createWebSocket();
  const messageHandlers: Array<(data: ESObject) => void> = [];
  const openHandlers: Array<() => void> = [];
  const closeHandlers: Array<(event?: ESObject) => void> = [];
  const errorHandlers: Array<(event?: ESObject) => void> = [];

  // Connection setup
  const connectOptions: webSocket.WebSocketRequestOptions = {
    header: headers ?? {} as Record<string, string>,
  };

  if (protocols !== undefined && protocols.length > 0) {
    const headerValue: string = protocols.join(', ');
    (connectOptions.header as Record<string, string>)['Sec-WebSocket-Protocol'] = headerValue;
  }

  ws.connect(url, connectOptions, (err: Error | null) => {
    if (err !== null) {
      if (logger !== undefined) {
        const logData: LoggerWarnData = { err: err.message, url: url };
        logger.warn(logData, 'HarmonyTransport: connect failed');
      }
      for (const handler of errorHandlers) {
        const errorData: ErrorEventData = { message: err.message };
        handler(errorData as ESObject);
      }
      return;
    }

    if (logger !== undefined) {
      const logData: LoggerWarnData = { url: url };
      logger.warn(logData, 'HarmonyTransport: connected');
    }

    // Message handler
    ws.on('message', (err: Error | null, value: string | ArrayBuffer) => {
      if (err !== null) {
        if (logger !== undefined) {
          const logData: LoggerWarnData = { err: err.message };
          logger.warn(logData, 'HarmonyTransport: message error');
        }
        return;
      }
      for (const handler of messageHandlers) {
        handler(value as ESObject);
      }
    });

    // Close handler
    ws.on('close', (err: Error | null, value: webSocket.CloseResult) => {
      if (logger !== undefined) {
        const logData: LoggerWarnData = {
          code: value.code,
          reason: value.reason,
          err: err !== null ? err.message : undefined,
        };
        logger.warn(logData, 'HarmonyTransport: closed');
      }
      for (const handler of closeHandlers) {
        const closeData: CloseEventData = { code: value.code, reason: value.reason };
        handler(closeData as ESObject);
      }
    });

    // Error handler
    ws.on('error', (err: Error) => {
      if (logger !== undefined) {
        const logData: LoggerWarnData = { err: err.message };
        logger.warn(logData, 'HarmonyTransport: error');
      }
      for (const handler of errorHandlers) {
        const errorData: ErrorEventData = { message: err.message };
        handler(errorData as ESObject);
      }
    });

    // Fire open handlers
    for (const handler of openHandlers) {
      handler();
    }
  });

  // DaemonTransport interface
  const transport: DaemonTransport = {
    send(data: string | Uint8Array | ArrayBuffer): void {
      ws.send(data);
    },

    close(code?: number, reason?: string): void {
      ws.close({
        code: code !== undefined ? code : 1000,
        reason: reason !== undefined ? reason : '',
      });
    },

    onMessage(handler: (data: ESObject) => void): () => void {
      messageHandlers.push(handler);
      return (): void => {
        const idx: number = messageHandlers.indexOf(handler);
        if (idx !== -1) {
          messageHandlers.splice(idx, 1);
        }
      };
    },

    onOpen(handler: () => void): () => void {
      openHandlers.push(handler);
      return (): void => {
        const idx: number = openHandlers.indexOf(handler);
        if (idx !== -1) {
          openHandlers.splice(idx, 1);
        }
      };
    },

    onClose(handler: (event?: ESObject) => void): () => void {
      closeHandlers.push(handler);
      return (): void => {
        const idx: number = closeHandlers.indexOf(handler);
        if (idx !== -1) {
          closeHandlers.splice(idx, 1);
        }
      };
    },

    onError(handler: (event?: ESObject) => void): () => void {
      errorHandlers.push(handler);
      return (): void => {
        const idx: number = errorHandlers.indexOf(handler);
        if (idx !== -1) {
          errorHandlers.splice(idx, 1);
        }
      };
    },
  };

  return transport;
}

/**
 * Decode a Paseo terminal binary frame.
 */
export enum TerminalOpcode {
  Output = 0x01,
  Input = 0x02,
  Resize = 0x03,
  Snapshot = 0x04,
}

export interface TerminalFrame {
  opcode: TerminalOpcode;
  slot: number;
  payload: Uint8Array;
}

export function decodeTerminalFrame(data: ArrayBuffer): TerminalFrame | null {
  if (data.byteLength < 2) {
    return null;
  }

  const bytes: Uint8Array = new Uint8Array(data);
  const frame: TerminalFrame = {
    opcode: bytes[0] as TerminalOpcode,
    slot: bytes[1],
    payload: bytes.slice(2),
  };
  return frame;
}
