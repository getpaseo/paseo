import net from "node:net";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Logger } from "pino";
import pino from "pino";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";


type BridgeEnvelope =
  | { type: "init"; callerAgentId: string }
  | { type: "mcp"; message: JSONRPCMessage }
  | { type: "ready" }
  | { type: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEnvelope(raw: string): BridgeEnvelope {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Invalid bridge envelope");
  }
  if (parsed.type === "init") {
    const callerAgentId = typeof parsed.callerAgentId === "string" ? parsed.callerAgentId.trim() : "";
    if (!callerAgentId) {
      throw new Error("Invalid init payload: callerAgentId is required");
    }
    return { type: "init", callerAgentId };
  }
  if (parsed.type === "mcp") {
    if (!("message" in parsed)) {
      throw new Error("Invalid mcp payload: message is required");
    }
    return { type: "mcp", message: parsed.message as JSONRPCMessage };
  }
  if (parsed.type === "ready") return { type: "ready" };
  if (parsed.type === "error") {
    return { type: "error", message: typeof parsed.message === "string" ? parsed.message : "Unknown error" };
  }
  throw new Error(`Unknown envelope type: ${parsed.type}`);
}

function encodeEnvelope(envelope: BridgeEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export type VoiceMcpBridgeSocketServer = {
  socketPath: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createVoiceMcpBridgeSocketServer(params: {
  socketPath: string;
  logger: Logger;
  createAgentMcpServerForCaller: (callerAgentId: string) => Promise<{ connect: (transport: InMemoryTransport) => Promise<void>; close?: () => Promise<void> }>;
}): VoiceMcpBridgeSocketServer {
  const logger = params.logger.child({ module: "voice-mcp-bridge" });
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const connectionLogger = logger.child({ component: "connection" });
    let readBuffer = "";
    let initialized = false;
    let clientTransport: InMemoryTransport | null = null;
    let mcpServer: { close?: () => Promise<void> } | null = null;

    const send = (payload: BridgeEnvelope) => {
      socket.write(encodeEnvelope(payload));
    };

    const fail = (message: string) => {
      send({ type: "error", message });
      socket.end();
    };

    const cleanup = async () => {
      sockets.delete(socket);
      const closeTasks: Promise<unknown>[] = [];
      if (clientTransport) {
        closeTasks.push(clientTransport.close().catch(() => undefined));
      }
      if (mcpServer?.close) {
        closeTasks.push(mcpServer.close().catch(() => undefined));
      }
      await Promise.all(closeTasks);
    };

    socket.on("data", (chunk) => {
      readBuffer += chunk.toString("utf8");
      while (true) {
        const newlineIndex = readBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = readBuffer.slice(0, newlineIndex).trim();
        readBuffer = readBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let message: BridgeEnvelope;
        try {
          message = parseEnvelope(line);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          return;
        }

        if (message.type === "init") {
          if (initialized) {
            fail("Bridge already initialized");
            return;
          }
          initialized = true;
          void (async () => {
            try {
              const [proxyClient, proxyServer] = InMemoryTransport.createLinkedPair();
              const serverInstance = await params.createAgentMcpServerForCaller(message.callerAgentId);
              await serverInstance.connect(proxyServer);
              await proxyClient.start();
              proxyClient.onmessage = (jsonrpcMessage) => {
                send({ type: "mcp", message: jsonrpcMessage });
              };
              clientTransport = proxyClient;
              mcpServer = serverInstance;
              send({ type: "ready" });
            } catch (error) {
              connectionLogger.error({ err: error }, "Failed to initialize voice MCP bridge connection");
              fail(error instanceof Error ? error.message : String(error));
            }
          })();
          continue;
        }

        if (message.type === "mcp") {
          if (!clientTransport) {
            fail("Bridge is not initialized");
            return;
          }
          void clientTransport.send(message.message).catch((error) => {
            connectionLogger.error({ err: error }, "Failed to forward MCP message");
            fail(error instanceof Error ? error.message : String(error));
          });
          continue;
        }
      }
    });

    socket.on("error", (error) => {
      connectionLogger.error({ err: error }, "Voice MCP bridge socket error");
    });
    socket.on("close", () => {
      void cleanup();
    });
  });

  return {
    socketPath: params.socketPath,
    async start() {
      await mkdir(path.dirname(params.socketPath), { recursive: true });
      await rm(params.socketPath, { force: true }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(params.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger.info({ socketPath: params.socketPath }, "Voice MCP bridge socket server listening");
    },
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(params.socketPath, { force: true }).catch(() => undefined);
    },
  };
}

function parseBridgeCliArgs(argv: string[]): { socketPath: string; callerAgentId: string } {
  let socketPath: string | null = null;
  let callerAgentId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--socket") {
      socketPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--caller-agent-id") {
      callerAgentId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
  }

  if (!socketPath?.trim()) {
    throw new Error("Missing required --socket <path>");
  }
  if (!callerAgentId?.trim()) {
    throw new Error("Missing required --caller-agent-id <id>");
  }

  return {
    socketPath: socketPath.trim(),
    callerAgentId: callerAgentId.trim(),
  };
}

export async function runVoiceMcpBridgeCli(argv: string[], logger?: Logger): Promise<void> {
  const bridgeLogger = logger ?? pino({ level: "error" });
  const parsed = parseBridgeCliArgs(argv);

  const socket = net.createConnection(parsed.socketPath);
  const stdioTransport = new StdioServerTransport(process.stdin, process.stdout);
  let ready = false;
  let socketBuffer = "";

  const sendEnvelope = (payload: BridgeEnvelope) => {
    socket.write(encodeEnvelope(payload));
  };

  const closeWithError = (message: string): never => {
    throw new Error(message);
  };

  socket.on("data", (chunk) => {
    socketBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = socketBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = socketBuffer.slice(0, newlineIndex).trim();
      socketBuffer = socketBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      const envelope = parseEnvelope(line);
      if (envelope.type === "ready") {
        ready = true;
        continue;
      }
      if (envelope.type === "error") {
        socket.destroy();
        closeWithError(`Voice MCP bridge error: ${envelope.message}`);
      }
      if (envelope.type === "mcp") {
        void stdioTransport.send(envelope.message);
      }
    }
  });

  socket.on("error", (error) => {
    bridgeLogger.error({ err: error }, "Voice MCP bridge socket client error");
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  sendEnvelope({ type: "init", callerAgentId: parsed.callerAgentId });

  // Wait for bridge readiness before forwarding stdio messages.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error("Timed out waiting for voice MCP bridge initialization"));
    }, 10000);
    const checkReady = () => {
      if (ready) {
        clearTimeout(deadline);
        resolve();
      } else {
        setTimeout(checkReady, 25);
      }
    };
    checkReady();
  });

  stdioTransport.onmessage = (message) => {
    sendEnvelope({ type: "mcp", message });
  };
  stdioTransport.onerror = (error) => {
    bridgeLogger.error({ err: error }, "Voice MCP stdio transport error");
    socket.destroy();
  };
  stdioTransport.onclose = () => {
    socket.end();
  };

  await stdioTransport.start();

  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    process.stdin.once("end", () => resolve());
  });

  await stdioTransport.close().catch(() => undefined);
}
