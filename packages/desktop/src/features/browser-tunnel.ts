import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export interface BrowserTunnelEvent {
  tunnelId: string;
  connectionId: string;
  kind: "open" | "data" | "close";
  dataBase64?: string;
}

export class BrowserTunnelHost {
  private readonly listeners = new Map<string, { server: Server; port: Promise<number> }>();
  private readonly sockets = new Map<
    string,
    { socket: Socket; tunnelId: string; resume: () => void }
  >();

  constructor(private readonly emit: (event: BrowserTunnelEvent) => void) {}

  start(tunnelId: string): Promise<number> {
    if (typeof tunnelId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tunnelId))
      throw new Error("Invalid tunnel ID");
    const existing = this.listeners.get(tunnelId);
    if (existing) return existing.port;
    const server = createServer((socket) => {
      socket.pause();
      const connectionId = randomUUID();
      let waiting = true;
      const pump = () => {
        if (waiting || !socket.readableLength) return;
        const data: Buffer | null = socket.read(Math.min(32768, socket.readableLength));
        if (!data) return;
        waiting = true;
        this.emit({ tunnelId, connectionId, kind: "data", dataBase64: data.toString("base64") });
      };
      this.sockets.set(connectionId, {
        socket,
        tunnelId,
        resume: () => {
          waiting = false;
          pump();
        },
      });
      socket.on("readable", pump);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        this.sockets.delete(connectionId);
        this.emit({ tunnelId, connectionId, kind: "close" });
      });
      this.emit({ tunnelId, connectionId, kind: "open" });
    });
    const port = new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string")
          reject(new Error("Tunnel listener unavailable"));
        else resolve(address.port);
      });
    });
    this.listeners.set(tunnelId, { server, port });
    void port.catch(() => this.listeners.delete(tunnelId));
    return port;
  }

  async stop(tunnelId: string): Promise<void> {
    const listener = this.listeners.get(tunnelId);
    if (!listener) return;
    this.listeners.delete(tunnelId);
    for (const [id, connection] of this.sockets) {
      if (connection.tunnelId === tunnelId) this.close(id);
    }
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }

  write(connectionId: string, dataBase64: string): Promise<void> {
    if (
      typeof dataBase64 !== "string" ||
      dataBase64.length > 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
    )
      throw new Error("Invalid tunnel data");
    const connection = this.sockets.get(connectionId);
    if (!connection) throw new Error("Unknown tunnel connection");
    return new Promise((resolve, reject) => {
      connection.socket.write(Buffer.from(dataBase64, "base64"), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  resume(connectionId: string): void {
    this.sockets.get(connectionId)?.resume();
  }

  close(connectionId: string): void {
    this.sockets.get(connectionId)?.socket.destroy();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.listeners.keys()].map((id) => this.stop(id)));
  }
}
