import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { NetworkTunnel, NetworkTunnelStream } from "@getpaseo/client/internal/daemon-client";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/index";

const LOOPBACK = "127.0.0.1";

export interface TcpForward {
  readonly port: number;
  close(): Promise<void>;
}

function bridge(socket: Socket, tunnel: NetworkTunnel, targetPort: number): void {
  socket.pause();
  let stream: NetworkTunnelStream;
  let connected = false;
  let localEnded = false;
  let closed = false;
  let credit = 0;
  let queuedBytes = 0;
  const queued: Buffer[] = [];

  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    stream?.close();
  };
  const drain = () => {
    if (!connected || closed) return;
    while (queued.length && credit > 0) {
      const chunk = queued[0]!;
      const size = Math.min(chunk.length, credit, tunnel.limits.maxDataBytes);
      stream.write(chunk.subarray(0, size));
      credit -= size;
      queuedBytes -= size;
      if (size === chunk.length) queued.shift();
      else queued[0] = chunk.subarray(size);
    }
    if (localEnded && queued.length === 0) {
      close();
      return;
    }
    if (queuedBytes < tunnel.limits.initialWindowBytes) socket.resume();
  };

  try {
    stream = tunnel.openStream(
      { host: "localhost", port: targetPort },
      {
        onConnected: () => {
          connected = true;
          credit = tunnel.limits.initialWindowBytes;
          socket.on("data", (chunk: Buffer) => {
            try {
              queued.push(chunk);
              queuedBytes += chunk.length;
              if (queuedBytes >= tunnel.limits.initialWindowBytes) socket.pause();
              drain();
            } catch {
              close();
            }
          });
          socket.resume();
        },
        onData: (data) => {
          // Return credit only after the bytes have been written to the local socket.
          socket.write(Buffer.from(data), (error) => {
            if (error) close();
            else stream.consume(data.length);
          });
        },
        onCredit: (amount) => {
          credit += amount;
          try {
            drain();
          } catch {
            close();
          }
        },
        onClose: (reason) => {
          if (reason !== TunnelCloseReason.Ok) {
            close();
            return;
          }
          closed = true;
          // Queue FIN after data already written to the local socket.
          socket.end();
        },
      },
    );
  } catch {
    socket.destroy();
    return;
  }
  socket.once("end", () => {
    localEnded = true;
    drain();
  });
  socket.on("error", close);
  socket.on("close", close);
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/** Bind the requested loopback port, falling back to a free port only for defaults. */
export async function startTcpForward(
  tunnel: NetworkTunnel,
  targetPort: number,
  localPort: number = targetPort,
  allowPortFallback = true,
): Promise<TcpForward> {
  const sockets = new Set<Socket>();
  const createListener = () =>
    createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      bridge(socket, tunnel, targetPort);
    });
  let server = createListener();
  let port: number;
  try {
    port = await listen(server, localPort);
  } catch (error) {
    if (!allowPortFallback || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    server = createListener();
    port = await listen(server, 0);
  }
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
