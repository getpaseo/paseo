import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

interface VitestProject {
  provide: (key: "passwordlessRelayUrl", value: string) => void;
}

export default async function setup(project: VitestProject): Promise<() => Promise<void>> {
  const server = createServer();
  const clients = new Set<Duplex>();

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/relay") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    // This relay-style server deliberately selects no subprotocol.
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    if (head.length > 0) {
      socket.unshift(head);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser WebSocket regression server did not expose a TCP address");
  }
  project.provide("passwordlessRelayUrl", `ws://127.0.0.1:${address.port}/relay`);

  return async () => {
    for (const client of clients) {
      client.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
}
