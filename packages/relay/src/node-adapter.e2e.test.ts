import { existsSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createClientChannel,
  createDaemonChannel,
  generateKeyPair,
  exportPublicKey,
  type Transport,
} from "./index.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PACKAGE_ROOT = path.resolve(THIS_DIR, "..");
const DIST_NODE_CLI_PATH = path.resolve(RELAY_PACKAGE_ROOT, "dist/node-cli.js");
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

type SocketHarness = {
  ws: WebSocket;
  nextMessage(label: string): Promise<string | Buffer>;
};

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number, relayProcess: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (relayProcess.exitCode !== null) {
      throw new Error(`relay process exited early with code ${relayProcess.exitCode}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Server did not start on port ${port}`);
}

function ensureNodeCliBuilt(): void {
  execFileSync("npm", ["run", "build"], {
    cwd: RELAY_PACKAGE_ROOT,
    stdio: "inherit",
  });
  if (!existsSync(DIST_NODE_CLI_PATH)) {
    throw new Error(`Expected Node relay CLI at ${DIST_NODE_CLI_PATH}`);
  }
}

function connectHarness(url: string, label: string): Promise<SocketHarness> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queuedMessages: Array<string | Buffer> = [];
    const waitingMessages: Array<(message: string | Buffer) => void> = [];

    ws.on("message", (data) => {
      const message = data as string | Buffer;
      const waiter = waitingMessages.shift();
      if (waiter) {
        waiter(message);
        return;
      }
      queuedMessages.push(message);
    });

    ws.once("open", () => {
      resolve({
        ws,
        nextMessage(messageLabel: string) {
          return new Promise((innerResolve, innerReject) => {
            if (queuedMessages.length > 0) {
              innerResolve(queuedMessages.shift()!);
              return;
            }
            const timeout = setTimeout(
              () => innerReject(new Error(`Timed out waiting for ${messageLabel}`)),
              10_000,
            );
            waitingMessages.push((message) => {
              clearTimeout(timeout);
              innerResolve(message);
            });
            ws.once("error", (error) => {
              clearTimeout(timeout);
              innerReject(error);
            });
          });
        },
      });
    });

    ws.once("error", reject);

    setTimeout(() => reject(new Error(`Timed out opening ${label}`)), 10_000);
  });
}

function createWsTransport(ws: WebSocket): Transport {
  return {
    send(data) {
      ws.send(data);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

describe("Node relay CLI E2E", () => {
  let relayPort: number;
  let relayProcess: ChildProcess | null = null;

  beforeAll(async () => {
    relayPort = await getAvailablePort();
    ensureNodeCliBuilt();

    relayProcess = spawn(process.execPath, [DIST_NODE_CLI_PATH], {
      cwd: RELAY_PACKAGE_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(relayPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    relayProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((line) => line.trim().length > 0);
      for (const line of lines) {
        console.log(`[node-relay] ${line}`);
      }
    });

    relayProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((line) => line.trim().length > 0);
      for (const line of lines) {
        console.error(`[node-relay] ${line}`);
      }
    });

    await waitForServer(relayPort, relayProcess);
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (!relayProcess || relayProcess.exitCode !== null) {
      return;
    }

    relayProcess.kill("SIGTERM");
    const startedAt = Date.now();
    while (relayProcess.exitCode === null && Date.now() - startedAt < SHUTDOWN_TIMEOUT_MS) {
      await sleep(50);
    }

    if (relayProcess.exitCode === null) {
      relayProcess.kill("SIGKILL");
    }
  }, SHUTDOWN_TIMEOUT_MS);

  it("starts the Node relay entrypoint and bridges encrypted traffic", async () => {
    const serverId = `node-e2e-${Date.now()}`;
    const connectionId = `conn_node_e2e_${Date.now()}`;
    const daemonKeyPair = await generateKeyPair();
    const daemonPublicKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);

    const control = await connectHarness(
      `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&v=2`,
      "control socket",
    );
    const client = await connectHarness(
      `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`,
      "client socket",
    );

    try {
      const initialSync = JSON.parse((await control.nextMessage("initial sync")).toString()) as {
        type: string;
        connectionIds?: string[];
      };
      expect(initialSync).toEqual({ type: "sync", connectionIds: [] });

      const connected = JSON.parse((await control.nextMessage("connected")).toString()) as {
        type: string;
        connectionId?: string;
      };
      expect(connected).toEqual({ type: "connected", connectionId });

      const daemon = await connectHarness(
        `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&connectionId=${connectionId}&v=2`,
        "daemon data socket",
      );

      try {
        const clientTransport = createWsTransport(client.ws);
        client.ws.on("message", (data) => {
          clientTransport.onmessage?.(typeof data === "string" ? data : data.toString());
        });
        client.ws.on("close", (code, reason) => {
          clientTransport.onclose?.(code, reason.toString());
        });
        client.ws.on("error", (error) => {
          clientTransport.onerror?.(error as Error);
        });

        const daemonTransport = createWsTransport(daemon.ws);
        daemon.ws.on("message", (data) => {
          daemonTransport.onmessage?.(typeof data === "string" ? data : data.toString());
        });
        daemon.ws.on("close", (code, reason) => {
          daemonTransport.onclose?.(code, reason.toString());
        });
        daemon.ws.on("error", (error) => {
          daemonTransport.onerror?.(error as Error);
        });

        let resolveDaemonReceived!: (value: string) => void;
        let rejectDaemonReceived!: (error: unknown) => void;
        const daemonReceived = new Promise<string>((resolve, reject) => {
          resolveDaemonReceived = resolve;
          rejectDaemonReceived = reject;
        });

        let resolveClientReceived!: (value: string) => void;
        let rejectClientReceived!: (error: unknown) => void;
        const clientReceived = new Promise<string>((resolve, reject) => {
          resolveClientReceived = resolve;
          rejectClientReceived = reject;
        });

        const [daemonChannel, clientChannel] = await Promise.all([
          createDaemonChannel(daemonTransport, daemonKeyPair, {
            onmessage: (data: string | ArrayBuffer) => {
              resolveDaemonReceived(
                typeof data === "string" ? data : new TextDecoder().decode(data),
              );
            },
            onerror: (error) => {
              rejectDaemonReceived(error);
            },
          }),
          createClientChannel(clientTransport, daemonPublicKeyB64, {
            onmessage: (data: string | ArrayBuffer) => {
              resolveClientReceived(
                typeof data === "string" ? data : new TextDecoder().decode(data),
              );
            },
            onerror: (error) => {
              rejectClientReceived(error);
            },
          }),
        ]);

        await clientChannel.send("hello-from-client");
        await expect(daemonReceived).resolves.toBe("hello-from-client");

        await daemonChannel.send("hello-from-daemon");
        await expect(clientReceived).resolves.toBe("hello-from-daemon");
      } finally {
        daemon.ws.close();
      }
    } finally {
      client.ws.close();
      control.ws.close();
    }
  }, 60_000);
});
