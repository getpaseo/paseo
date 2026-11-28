import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

export interface SteeringPeerOptions {
  initialize?: Record<string, unknown>;
  resume?: "load" | "resume";
  receipt?: unknown;
  rpcError?: boolean;
  holdReceipt?: boolean;
}
interface SteeringPeerState {
  calls: Array<{ method: string; params: unknown }>;
  order: string[];
  permissionResults: unknown[];
}
type ControlMethod =
  | "prompt-started"
  | "steering-started"
  | "ack-steer"
  | "release"
  | "state"
  | "permissions"
  | "permission-results"
  | "reply-sent"
  | "disconnect";
interface ControlResponse {
  id: number;
  state: SteeringPeerState;
}

// This channel drives only the injected CLI adapter. It never obtains the ACP
// client's connection or modifies the session under test.
export async function createSteeringPeerControl() {
  const ready = Promise.withResolvers<Socket>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<SteeringPeerState>>>();
  let socket: Socket | undefined;
  const sockets = new Set<Socket>();
  let nextId = 0;
  const server = createServer((connected) => {
    socket = connected;
    sockets.add(connected);
    connected.setEncoding("utf8");
    const lines = createInterface({ input: connected });
    lines.on("line", (line) => {
      const response: ControlResponse = JSON.parse(line);
      const waiter = pending.get(response.id);
      pending.delete(response.id);
      waiter?.resolve(response.state);
    });
    connected.on("close", () => {
      sockets.delete(connected);
      if (connected !== socket) return;
      for (const waiter of pending.values())
        waiter.reject(new Error("Steering peer control disconnected"));
      pending.clear();
    });
    connected.on("error", (error) => {
      if (connected !== socket) return;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    ready.resolve(connected);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP control port");
  return {
    port: address.port,
    connected: () => socket !== undefined && !socket.destroyed && !socket.readableEnded,
    async request(method: ControlMethod): Promise<SteeringPeerState> {
      // Catalog discovery may launch an earlier peer. The session handshake
      // connects before create/resume returns, so target the latest live peer.
      await ready.promise;
      const connected = socket;
      if (!connected || connected.destroyed) throw new Error("Steering peer disconnected");
      const id = ++nextId;
      const waiter = Promise.withResolvers<SteeringPeerState>();
      pending.set(id, waiter);
      connected.write(`${JSON.stringify({ id, method })}\n`);
      return waiter.promise;
    },
    async close() {
      for (const connected of sockets) connected.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
}
