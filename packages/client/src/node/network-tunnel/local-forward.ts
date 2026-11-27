import net, { type Server, type Socket } from "node:net";
import { NetworkTunnelCloseReason } from "@getpaseo/protocol/network-tunnel";
import type { TunnelMuxClient } from "./tunnel-mux.js";
import type { SocketOwnerVerifier } from "./socket-owner.js";

export interface LocalForward {
  port: number;
  close(): Promise<void>;
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("No forward port assigned"));
      else resolve(address.port);
    });
  });
}

export async function startLocalForward({
  remotePort,
  localPort,
  verifyOwner,
  mux,
}: {
  remotePort: number;
  localPort?: number;
  verifyOwner: SocketOwnerVerifier;
  mux: TunnelMuxClient;
}): Promise<LocalForward> {
  const sockets = new Set<Socket>();
  const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const address = server.address();
    const clientPort = socket.remotePort;
    if (!address || typeof address === "string" || !clientPort) {
      socket.destroy();
      return;
    }
    void accept(socket, clientPort, address.port).catch(() => socket.destroy());
  });
  async function accept(socket: Socket, clientPort: number, serverPort: number) {
    if (!(await verifyOwner({ clientPort, serverPort })) || mux.isClosed() || socket.destroyed) {
      socket.destroy();
      return;
    }
    const openLoopback = (host: "127.0.0.1" | "::1") =>
      mux.openStream({ host, port: remotePort, socket, onOpened: () => socket.resume() });
    let result = await openLoopback("127.0.0.1");
    if (
      !result.ok &&
      result.reason === NetworkTunnelCloseReason.ConnectRefused &&
      !socket.destroyed
    ) {
      result = await openLoopback("::1");
    }
    if (!result.ok) socket.destroy();
  }
  server.maxConnections = 32;
  let port: number;
  try {
    port = await listen(server, localPort ?? remotePort);
  } catch (error) {
    if (localPort !== undefined || (error as NodeJS.ErrnoException).code !== "EADDRINUSE")
      throw error;
    port = await listen(server, 0);
  }
  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
