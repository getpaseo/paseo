import { BrowserWindow } from "electron";
import { WebSocket, type RawData } from "ws";

interface TransportTarget {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface WebSocketTransportTarget {
  transportType: "websocket";
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

interface TransportEventPayload {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
}

interface Session {
  id: string;
  ws: WebSocket;
  state: "opening" | "open" | "closing" | "closed";
}

const WS_ENDPOINT_PATH = "/ws";
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

let nextSessionId = 0;
const sessions = new Map<string, Session>();

function emitTransportEvent(payload: TransportEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:local-daemon-transport-event", payload);
  }
}

/**
 * Build a WebSocket URL that connects through a Unix domain socket or Windows
 * named pipe.  The `ws` library supports these via the `ws+unix://` scheme:
 *
 *   ws+unix:///path/to/socket:/ws
 *   ws+unix://./pipe/paseo:/ws        (Windows named pipe)
 *
 * The part before `:` is the IPC path, the part after is the HTTP request
 * path used during the WebSocket upgrade handshake.
 */
function buildLocalWebSocketUrl(target: TransportTarget): string {
  const ipcPath = target.transportPath;
  return `ws+unix://${ipcPath}:${WS_ENDPOINT_PATH}`;
}

function describeTransportTarget(target: TransportTarget): string {
  return target.transportType === "pipe" ? "local daemon pipe" : "local daemon socket";
}

function normalizeWebSocketTarget(target: WebSocketTransportTarget): WebSocketTransportTarget {
  const parsed = new URL(target.url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported WebSocket transport URL: ${target.url}`);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    if (!HTTP_HEADER_NAME_PATTERN.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error("Invalid WebSocket transport header.");
    }
    headers[name] = value;
  }

  return {
    transportType: "websocket",
    url: parsed.toString(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(target.protocols?.length ? { protocols: [...target.protocols] } : {}),
  };
}

function decodeTransportMessage(input: { text?: string; binaryBase64?: string }): string | Buffer {
  if (typeof input.text === "string") {
    return input.text;
  }

  if (typeof input.binaryBase64 === "string") {
    return Buffer.from(input.binaryBase64, "base64");
  }

  throw new Error("Local transport send requires text or binary payload.");
}

export function openLocalTransportSession(target: TransportTarget): Promise<string> {
  return openTransportSession(buildLocalWebSocketUrl(target), describeTransportTarget(target));
}

export function openWebSocketTransportSession(target: WebSocketTransportTarget): Promise<string> {
  const normalized = normalizeWebSocketTarget(target);
  return openTransportSession(normalized.url, "remote daemon", {
    headers: normalized.headers,
    protocols: normalized.protocols,
  });
}

function openTransportSession(
  url: string,
  targetDescription: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
): Promise<string> {
  const sessionId = `local-session-${++nextSessionId}`;

  return new Promise((resolve, reject) => {
    const ws = options?.protocols
      ? new WebSocket(url, options.protocols, { headers: options.headers })
      : new WebSocket(url, { headers: options?.headers });
    const session: Session = {
      id: sessionId,
      ws,
      state: "opening",
    };
    sessions.set(sessionId, session);

    let openSettled = false;

    const finalizeOpenFailure = (message: string): void => {
      if (openSettled) {
        return;
      }

      openSettled = true;
      session.state = "closed";
      sessions.delete(sessionId);
      reject(new Error(message));
    };

    ws.once("open", () => {
      openSettled = true;
      session.state = "open";
      resolve(sessionId);
      emitTransportEvent({ sessionId, kind: "open" });
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || data instanceof Buffer) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        emitTransportEvent({
          sessionId,
          kind: "message",
          binaryBase64: buf.toString("base64"),
        });
        return;
      }

      emitTransportEvent({
        sessionId,
        kind: "message",
        text: data.toString(),
      });
    });

    ws.on("close", (code: number, reason?: Buffer | string) => {
      const shouldEmitClose = session.state === "open" || session.state === "closing";
      session.state = "closed";
      sessions.delete(sessionId);

      if (!openSettled) {
        finalizeOpenFailure(`${targetDescription} closed before the session became ready.`);
        return;
      }

      if (shouldEmitClose) {
        emitTransportEvent({
          sessionId,
          kind: "close",
          code,
          reason: reason ? String(reason) : "",
        });
      }
    });

    ws.on("error", (err: Error) => {
      if (!openSettled) {
        finalizeOpenFailure(`Failed to connect to ${targetDescription}: ${err.message}`);
        return;
      }

      emitTransportEvent({
        sessionId,
        kind: "error",
        error: err.message,
      });
    });
  });
}

export async function sendLocalTransportMessage(input: {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}): Promise<void> {
  const session = sessions.get(input.sessionId);
  if (!session) {
    throw new Error(`Local transport session not found: ${input.sessionId}`);
  }

  if (session.state !== "open" || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error(
      session.state === "opening"
        ? "Local transport session is not open yet."
        : "Local transport session is closed.",
    );
  }

  const payload = decodeTransportMessage(input);
  await new Promise<void>((resolve, reject) => {
    session.ws.send(payload, (error) => {
      if (error) {
        reject(new Error(`Local transport write failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

export function closeLocalTransportSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    if (session.ws.readyState === WebSocket.CONNECTING) {
      session.state = "closed";
      session.ws.terminate();
    } else {
      session.state = "closing";
      session.ws.close();
    }
  } catch {
    // ignore close errors
  }
  sessions.delete(sessionId);
}

export function closeAllTransportSessions(): void {
  for (const [id] of sessions) {
    closeLocalTransportSession(id);
  }
}
