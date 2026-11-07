import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection } from "node:net";
import { attachFramedSocket, type FramedSocket } from "./terminal-worker-frames.js";
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  type TerminalWorkerHello,
  type TerminalWorkerHelloAck,
  type TerminalWorkerRequest,
  type TerminalWorkerToParentMessage,
} from "./terminal-worker-protocol.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** The daemon's (or cleanup's) authenticated connection to one terminal worker. */
export interface TerminalWorkerConnection {
  readonly connected: boolean;
  readonly workerPid: number;
  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean;
  /** Closes the socket. The worker keeps running and keeps its terminals. */
  disconnect(): void;
  on(event: "message", listener: (message: TerminalWorkerToParentMessage) => void): this;
  on(event: "close", listener: () => void): this;
}

export class TerminalWorkerConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalWorkerConnectError";
  }
}

class SocketTerminalWorkerConnection extends EventEmitter implements TerminalWorkerConnection {
  readonly workerPid: number;
  private readonly framed: FramedSocket;
  private closed = false;

  constructor(framed: FramedSocket, workerPid: number) {
    super();
    this.framed = framed;
    this.workerPid = workerPid;
    framed.socket.once("close", () => {
      this.closed = true;
      this.emit("close");
    });
  }

  get connected(): boolean {
    return !this.closed && !this.framed.socket.destroyed;
  }

  send(message: TerminalWorkerRequest, callback: (error: Error | null) => void): boolean {
    return this.framed.send(message, callback);
  }

  disconnect(): void {
    this.framed.close();
  }

  deliver(message: TerminalWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

function isHelloAck(message: unknown): message is TerminalWorkerHelloAck {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "helloAck" &&
    typeof (message as { pid?: unknown }).pid === "number"
  );
}

/**
 * Connects to a worker's socket and authenticates with the record's secret. The worker closes
 * the socket on a wrong secret, so a rejected hello surfaces as a connect error.
 */
export function connectTerminalWorker(input: {
  socketPath: string;
  secret: string;
  timeoutMs?: number;
}): Promise<TerminalWorkerConnection> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.socketPath);
    let connection: SocketTerminalWorkerConnection | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new TerminalWorkerConnectError(
          `Terminal worker at ${input.socketPath} did not answer within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const framed = attachFramedSocket(socket, (message) => {
      if (connection) {
        connection.deliver(message as TerminalWorkerToParentMessage);
        return;
      }
      if (!isHelloAck(message)) {
        fail(new TerminalWorkerConnectError("Terminal worker sent an unexpected first frame"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      connection = new SocketTerminalWorkerConnection(framed, message.pid);
      resolve(connection);
    });
    // `on`, not `once`: an error after authentication must not go unhandled. `close`
    // follows every socket error and ends the connection.
    socket.on("error", (error) => {
      fail(
        new TerminalWorkerConnectError(
          `Cannot connect to terminal worker at ${input.socketPath}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    socket.once("close", () => {
      fail(
        new TerminalWorkerConnectError(
          `Terminal worker at ${input.socketPath} closed the connection during authentication`,
        ),
      );
    });
    socket.once("connect", () => {
      const hello: TerminalWorkerHello = {
        type: "hello",
        secret: input.secret,
        protocolVersion: TERMINAL_WORKER_PROTOCOL_VERSION,
      };
      framed.send(hello);
    });
  });
}

export type TerminalWorkerSocketProbe = "accepting" | "refused" | "unknown";

const PROBE_TIMEOUT_MS = 1_000;
// What a connect to a socket nobody listens on fails with: the unix socket file is left behind
// (ECONNREFUSED) or gone, as a Windows pipe is once its server closes (ENOENT).
const NO_LISTENER_ERRORS = new Set(["ECONNREFUSED", "ENOENT"]);

/**
 * Whether anything accepts connections on a worker's socket. It never authenticates, so the
 * daemon controlling the worker keeps control: the worker drops a connection that closes
 * before its hello.
 */
export async function probeTerminalWorkerSocket(
  socketPath: string,
): Promise<TerminalWorkerSocketProbe> {
  const socket = createConnection(socketPath);
  const timeout = new AbortController();
  try {
    return await Promise.race([
      once(socket, "connect").then(() => "accepting" as const),
      delay(PROBE_TIMEOUT_MS, "unknown" as const, { signal: timeout.signal }),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && NO_LISTENER_ERRORS.has(code) ? "refused" : "unknown";
  } finally {
    timeout.abort();
    socket.destroy();
  }
}
