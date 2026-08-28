import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  buildSshTunnelArgs,
  DEFAULT_SSH_DAEMON_PORT,
  validatePort,
  validateSshHost,
} from "@getpaseo/protocol/ssh-transport";
import { BrowserWindow } from "electron";
import { WebSocket, type RawData } from "ws";

export interface LocalTransportTarget {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface SshTransportTarget {
  transportType: "ssh";
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

export type TransportTarget = LocalTransportTarget | SshTransportTarget;

export interface TransportEventPayload {
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
  target: TransportTarget;
  ws: TransportWebSocket | null;
  state: "opening" | "open" | "closed";
  closeTarget: (() => void) | null;
  cancelSetupDeadline: () => void;
}

interface OpenTransportSessionInput {
  sessionId: string;
  target: TransportTarget;
}

export interface TransportEndpoint {
  url: string;
  close: () => void;
  failureDetail: () => string | null;
}

export interface TransportWebSocket {
  readonly readyState: number;
  once(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason?: Buffer | string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string | Buffer, callback: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}

export interface LocalTransportManagerDependencies {
  resolveEndpoint(target: TransportTarget): Promise<TransportEndpoint>;
  createWebSocket(url: string): TransportWebSocket;
  scheduleTimeout(callback: () => void, delayMs: number): () => void;
  emitEvent(payload: TransportEventPayload): void;
}

export interface LocalTransportManager {
  open(rawInput: unknown): void;
  send(input: { sessionId: string; text?: string; binaryBase64?: string }): Promise<void>;
  close(sessionId: string): void;
  closeAll(): void;
}

const WS_ENDPOINT_PATH = "/ws";
const SSH_STDERR_LIMIT = 8192;
export const LOCAL_TRANSPORT_SETUP_TIMEOUT_MS = 30_000;

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
function buildLocalWebSocketUrl(target: LocalTransportTarget): string {
  const ipcPath = target.transportPath;
  return `ws+unix://${ipcPath}:${WS_ENDPOINT_PATH}`;
}

function describeTransportTarget(target: TransportTarget): string {
  if (target.transportType === "ssh") {
    return `Remote SSH host ${target.host}`;
  }
  return target.transportType === "pipe" ? "local daemon pipe" : "local daemon socket";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTransportTarget(value: unknown): TransportTarget {
  if (!isRecord(value)) {
    throw new Error("Desktop transport target must be an object.");
  }

  if (value.transportType === "socket" || value.transportType === "pipe") {
    const transportPath = typeof value.transportPath === "string" ? value.transportPath.trim() : "";
    if (!transportPath) {
      throw new Error("Local transport path is required.");
    }
    return { transportType: value.transportType, transportPath };
  }

  if (value.transportType === "ssh") return parseSshTransportTarget(value);
  throw new Error("Unsupported desktop transport type.");
}

function parseSshTransportTarget(value: Record<string, unknown>): SshTransportTarget {
  const host = validateSshHost(typeof value.host === "string" ? value.host : "");
  const sshPort =
    value.sshPort === undefined ? undefined : validatePortValue(value.sshPort, "SSH port");
  const daemonPort =
    value.daemonPort === undefined ? undefined : validatePortValue(value.daemonPort, "Daemon port");
  return {
    transportType: "ssh",
    host,
    ...(sshPort !== undefined ? { sshPort } : {}),
    ...(daemonPort !== undefined ? { daemonPort } : {}),
  };
}

function validatePortValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be between 1 and 65535.`);
  try {
    return validatePort(value, label);
  } catch {
    throw new Error(`${label} must be between 1 and 65535.`);
  }
}

function parseOpenTransportSessionInput(value: unknown): OpenTransportSessionInput {
  if (!isRecord(value)) {
    throw new Error("Desktop transport open input must be an object.");
  }

  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
    throw new Error("Desktop transport session ID is invalid.");
  }

  return {
    sessionId,
    target: parseTransportTarget(value.target),
  };
}

export function buildSshArgs(target: SshTransportTarget): string[] {
  return buildSshTunnelArgs({
    host: target.host,
    ...(target.sshPort !== undefined ? { sshPort: target.sshPort } : {}),
    daemonPort: target.daemonPort ?? DEFAULT_SSH_DAEMON_PORT,
  });
}

function formatSshFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const detail = stderr.trim();
  if (detail) return detail;
  if (signal) return `ssh exited with signal ${signal}`;
  return `ssh exited with code ${code ?? "unknown"}`;
}

export function resolveSshFailureDetail(failure: string | null, stderr: string): string | null {
  return failure ?? (stderr.trim() || null);
}

function createSshProxy(target: SshTransportTarget): Promise<TransportEndpoint> {
  let server: Server | null = null;
  let socket: Socket | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stderr = "";
  let failure: string | null = null;

  function close(): void {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && !child.killed) {
      child.kill();
    }
    child = null;
  }

  return new Promise((resolve, reject) => {
    server = createServer((acceptedSocket) => {
      socket = acceptedSocket;
      server?.close();
      server = null;

      child = spawn("ssh", buildSshArgs(target), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-SSH_STDERR_LIMIT);
      });
      child.on("error", (error) => {
        failure = error.message;
        acceptedSocket.destroy(error);
      });
      child.on("exit", (code, signal) => {
        if (code !== 0 || signal) {
          failure = formatSshFailure(stderr, code, signal);
        }
        acceptedSocket.destroy(failure ? new Error(failure) : undefined);
      });

      acceptedSocket.on("error", () => undefined);
      acceptedSocket.on("close", () => {
        if (child && !child.killed) {
          child.kill();
        }
      });
      acceptedSocket.pipe(child.stdin);
      child.stdout.pipe(acceptedSocket);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Failed to allocate the Remote SSH proxy port."));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}${WS_ENDPOINT_PATH}`,
        close,
        failureDetail: () => resolveSshFailureDetail(failure, stderr),
      });
    });
  });
}

async function resolveTransportEndpoint(target: TransportTarget): Promise<TransportEndpoint> {
  if (target.transportType === "ssh") {
    return createSshProxy(target);
  }
  return {
    url: buildLocalWebSocketUrl(target),
    close: () => undefined,
    failureDetail: () => null,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLocalTransportManager(
  deps: LocalTransportManagerDependencies,
): LocalTransportManager {
  const sessions = new Map<string, Session>();

  function isCurrent(session: Session): boolean {
    return sessions.get(session.id) === session && session.state !== "closed";
  }

  function emitEvent(payload: TransportEventPayload): void {
    try {
      deps.emitEvent(payload);
    } catch {
      // A renderer may disappear while the main process is broadcasting an event.
    }
  }

  function disposeSession(session: Session): void {
    if (session.state === "closed") {
      return;
    }

    session.state = "closed";
    try {
      session.cancelSetupDeadline();
    } catch {
      // Continue releasing the socket and endpoint if a runtime adapter fails.
    }
    session.cancelSetupDeadline = () => undefined;
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
    }

    const ws = session.ws;
    session.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      } catch {
        // Closing is best-effort; the endpoint still owns the underlying transport.
      }
    }

    const closeTarget = session.closeTarget;
    session.closeTarget = null;
    try {
      closeTarget?.();
    } catch {
      // Closing is best-effort and must not prevent the registry from being released.
    }
  }

  function failOpeningSession(session: Session, message: string): void {
    if (!isCurrent(session) || session.state !== "opening") {
      return;
    }
    disposeSession(session);
    emitEvent({ sessionId: session.id, kind: "error", error: message });
  }

  async function connectSession(session: Session): Promise<void> {
    let endpoint: TransportEndpoint;
    try {
      endpoint = await deps.resolveEndpoint(session.target);
    } catch (error) {
      failOpeningSession(
        session,
        `Failed to connect to ${describeTransportTarget(session.target)}: ${getErrorMessage(error)}`,
      );
      return;
    }

    if (!isCurrent(session) || session.state !== "opening") {
      try {
        endpoint.close();
      } catch {
        // The cancelled session no longer owns any other resources to release.
      }
      return;
    }

    let targetClosed = false;
    session.closeTarget = () => {
      if (targetClosed) {
        return;
      }
      targetClosed = true;
      endpoint.close();
    };

    let ws: TransportWebSocket;
    try {
      ws = deps.createWebSocket(endpoint.url);
    } catch (error) {
      failOpeningSession(
        session,
        `Failed to connect to ${describeTransportTarget(session.target)}: ${getErrorMessage(error)}`,
      );
      return;
    }
    session.ws = ws;

    ws.once("open", () => {
      if (!isCurrent(session) || session.state !== "opening") {
        return;
      }
      session.cancelSetupDeadline();
      session.cancelSetupDeadline = () => undefined;
      session.state = "open";
      emitEvent({ sessionId: session.id, kind: "open" });
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isCurrent(session) || session.state !== "open") {
        return;
      }
      if (isBinary || data instanceof Buffer) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        emitEvent({
          sessionId: session.id,
          kind: "message",
          binaryBase64: buf.toString("base64"),
        });
        return;
      }

      emitEvent({
        sessionId: session.id,
        kind: "message",
        text: data.toString(),
      });
    });

    ws.on("close", (code: number, reason?: Buffer | string) => {
      if (!isCurrent(session)) {
        return;
      }
      if (session.state === "opening") {
        const failureDetail = endpoint.failureDetail();
        const detail = failureDetail ? `: ${failureDetail}` : "";
        failOpeningSession(
          session,
          `${describeTransportTarget(session.target)} closed before the session became ready${detail}.`,
        );
        return;
      }

      disposeSession(session);
      emitEvent({
        sessionId: session.id,
        kind: "close",
        code,
        reason: reason ? String(reason) : "",
      });
    });

    ws.on("error", (error: Error) => {
      if (!isCurrent(session)) {
        return;
      }
      const failureDetail = endpoint.failureDetail();
      const detail = failureDetail ? `${error.message}: ${failureDetail}` : error.message;
      if (session.state === "opening") {
        failOpeningSession(
          session,
          `Failed to connect to ${describeTransportTarget(session.target)}: ${detail}`,
        );
        return;
      }

      emitEvent({ sessionId: session.id, kind: "error", error: detail });
    });
  }

  function open(rawInput: unknown): void {
    const { sessionId, target } = parseOpenTransportSessionInput(rawInput);
    if (sessions.has(sessionId)) {
      throw new Error(`Local transport session already exists: ${sessionId}`);
    }

    const session: Session = {
      id: sessionId,
      target,
      ws: null,
      state: "opening",
      closeTarget: null,
      cancelSetupDeadline: () => undefined,
    };
    sessions.set(sessionId, session);
    session.cancelSetupDeadline = deps.scheduleTimeout(() => {
      failOpeningSession(
        session,
        `Connection to ${describeTransportTarget(target)} timed out during setup.`,
      );
    }, LOCAL_TRANSPORT_SETUP_TIMEOUT_MS);
    void connectSession(session);
  }

  async function send(input: {
    sessionId: string;
    text?: string;
    binaryBase64?: string;
  }): Promise<void> {
    const session = sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`Local transport session not found: ${input.sessionId}`);
    }

    const ws = session.ws;
    if (session.state !== "open" || !ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        session.state === "opening"
          ? "Local transport session is not open yet."
          : "Local transport session is closed.",
      );
    }

    const payload = decodeTransportMessage(input);
    await new Promise<void>((resolve, reject) => {
      ws.send(payload, (error) => {
        if (error) {
          reject(new Error(`Local transport write failed: ${error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  function close(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      disposeSession(session);
    }
  }

  function closeAll(): void {
    for (const session of sessions.values()) {
      disposeSession(session);
    }
  }

  return { open, send, close, closeAll };
}

const localTransportManager = createLocalTransportManager({
  resolveEndpoint: resolveTransportEndpoint,
  createWebSocket: (url) => new WebSocket(url),
  scheduleTimeout: (callback, delayMs) => {
    const timeout = setTimeout(callback, delayMs);
    timeout.unref();
    return () => clearTimeout(timeout);
  },
  emitEvent: emitTransportEvent,
});

export function openLocalTransportSession(rawInput: unknown): void {
  localTransportManager.open(rawInput);
}

export async function sendLocalTransportMessage(input: {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}): Promise<void> {
  await localTransportManager.send(input);
}

export function closeLocalTransportSession(sessionId: string): void {
  localTransportManager.close(sessionId);
}

export function closeAllTransportSessions(): void {
  localTransportManager.closeAll();
}
