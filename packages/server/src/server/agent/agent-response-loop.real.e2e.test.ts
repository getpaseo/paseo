import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import { createServer as createSocketServer, type Socket } from "net";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  generateStructuredAgentResponse,
  StructuredAgentTimeoutError,
} from "./agent-response-loop.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentMcpServer } from "./mcp-server.js";
import { shutdownProviders } from "./provider-registry.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "../daemon-e2e/real-provider-test-config.js";
import pino from "pino";

const CODEX_TEST_MODEL = getRealProviderConfig("codex").model;
const CODEX_TEST_THINKING_OPTION_ID = getRealProviderConfig("codex").thinkingOptionId;
const CLAUDE_TEST_MODEL = getRealProviderConfig("claude").model;

interface AgentMcpServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startAgentMcpServer(logger: pino.Logger): Promise<AgentMcpServerHandle> {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);

  const registryDir = mkdtempSync(path.join(tmpdir(), "agent-mcp-registry-"));
  const storagePath = path.join(registryDir, "agents");
  const agentStorage = new AgentStorage(storagePath, logger);
  const agentManager = new AgentManager({
    clients: {},
    registry: agentStorage,
    logger,
  });

  let mcpAllowedHosts: string[] | undefined;
  const agentMcpTransports = new Map<string, StreamableHTTPServerTransport>();

  const createAgentMcpTransport = async (callerAgentId?: string) => {
    const mcpServer = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId,
      logger,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        agentMcpTransports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        agentMcpTransports.delete(sessionId);
      },
      enableDnsRebindingProtection: true,
      ...(mcpAllowedHosts ? { allowedHosts: mcpAllowedHosts } : {}),
    });

    Object.assign(transport, {
      onclose: () => {
        if (transport.sessionId) {
          agentMcpTransports.delete(transport.sessionId);
        }
      },
      onerror: () => {
        // Ignore errors in test
      },
    });

    await mcpServer.connect(transport);
    return transport;
  };

  const runAgentMcpRequest = async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? agentMcpTransports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST") {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or invalid MCP session" },
            id: null,
          });
          return;
        }

        const body = req.body;
        if (!isInitializeRequest(body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32600, message: "First request must be initialize" },
            id: null,
          });
          return;
        }

        transport = await createAgentMcpTransport();
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  };

  const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
    void runAgentMcpRequest(req, res);
  };

  app.post("/mcp/agents", handleAgentMcpRequest);
  app.get("/mcp/agents", handleAgentMcpRequest);
  app.delete("/mcp/agents", handleAgentMcpRequest);

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  mcpAllowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const url = `http://127.0.0.1:${port}/mcp/agents`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

interface SinkholeHandle {
  port: number;
  close: () => Promise<void>;
}

// Accepts connections and never answers them, which is what a hung provider
// looks like from here. Live connections are destroyed on close because
// net.Server#close waits for them, and the killed child's socket can outlive
// the child.
async function startSinkhole(): Promise<SinkholeHandle> {
  const sockets = new Set<Socket>();
  const server = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// A leaked provider CLI is visible in the process table and nowhere else.
// Restricted to this process's own children: the developer running this may well
// have their own daemon spawning claude CLIs, and those must not count.
function providerCliPids(): Set<string> {
  const out = execFileSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" });
  const pids = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.includes("--output-format stream-json")) {
      continue;
    }
    const [pid, ppid] = line.trim().split(/\s+/);
    if (pid && ppid === String(process.pid)) {
      pids.add(pid);
    }
  }
  return pids;
}

describe("getStructuredAgentResponse (e2e)", () => {
  let manager: AgentManager;
  let cwd: string;
  let agentMcpServer: AgentMcpServerHandle;
  let canRunCodex = false;
  let canRunClaude = false;
  const logger = pino({ level: "silent" });

  beforeAll(async () => {
    canRunCodex = await canRunRealProvider("codex");
    canRunClaude = await canRunRealProvider("claude");
    if (!canRunCodex && !canRunClaude) {
      return;
    }
    agentMcpServer = await startAgentMcpServer(logger);
  });

  afterAll(async () => {
    await agentMcpServer?.close();
  });

  beforeEach(async () => {
    cwd = mkdtempSync(path.join(tmpdir(), "agent-response-loop-"));
    manager = new AgentManager({
      clients: createRealProviderClients(["codex", "claude"], logger),
      logger,
    });
  });

  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await shutdownProviders(logger);
  }, 60000);

  test("returns schema-valid JSON from a real Codex agent", async (context) => {
    if (!canRunCodex) {
      context.skip();
    }
    const schema = z.object({
      title: z.string(),
      count: z.number(),
    });

    const result = await generateStructuredAgentResponse({
      manager,
      agentConfig: {
        provider: "codex",
        model: CODEX_TEST_MODEL,
        ...(CODEX_TEST_THINKING_OPTION_ID
          ? { thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID }
          : {}),
        cwd,
        title: "Structured Response Test",
      },
      prompt: "Return JSON with a short title and count 2.",
      schema,
      maxRetries: 1,
    });

    expect(result.title.length).toBeGreaterThan(0);
    expect(typeof result.count).toBe("number");
  }, 180000);

  test("returns schema-valid JSON from Claude Haiku", async (context) => {
    if (!canRunClaude) {
      context.skip();
    }
    const schema = z.object({
      message: z.string(),
    });

    let result: { message: string } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await generateStructuredAgentResponse({
          manager,
          agentConfig: {
            provider: "claude",
            model: CLAUDE_TEST_MODEL,
            thinkingOptionId: "on",
            cwd,
            title: "Claude Haiku Structured Test",
            internal: true,
          },
          prompt:
            'Respond with exactly this JSON (no markdown, no extra keys, no extra text): {"message":"hello"}',
          schema,
          maxRetries: 6,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) {
      throw lastError;
    }

    expect(result.message.trim().toLowerCase()).toBe("hello");
  }, 180000);
});

// Regression for #1937: a generation that never reaches a terminal event left
// its provider CLI child (~250MB) alive for the lifetime of the daemon, because
// the close that reaps it lives in a finally block the run never reached.
//
// Separate from the suite above because it needs no API key and must not use
// one: the stall is a socket that accepts and never answers, which is what a
// hung provider looks like from here. Only the real `claude` binary is required.
describe("generateStructuredAgentResponse process cleanup (e2e)", () => {
  const logger = pino({ level: "silent" });
  let cwd: string;
  let claudeInstalled = false;

  beforeAll(async () => {
    claudeInstalled = await isCommandAvailable("claude");
  });

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "agent-response-loop-stall-"));
  });

  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await shutdownProviders(logger);
  }, 60000);

  test("reaps the provider CLI child when the run stalls", async (context) => {
    if (!claudeInstalled || process.platform === "win32") {
      context.skip();
    }

    const sinkhole = await startSinkhole();

    const manager = new AgentManager({
      clients: {
        claude: new ClaudeAgentClient({
          logger,
          runtimeSettings: {
            env: {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${sinkhole.port}`,
              ANTHROPIC_AUTH_TOKEN: "sinkhole",
              ANTHROPIC_API_KEY: "",
            },
          },
        }),
      },
      logger,
    });

    const before = providerCliPids();
    // Poll rather than checking only at the end, so "no leak" cannot pass
    // trivially by never spawning a child in the first place.
    const spawned = new Set<string>();
    const watcher = setInterval(() => {
      for (const pid of providerCliPids()) {
        if (!before.has(pid)) {
          spawned.add(pid);
        }
      }
    }, 100);

    try {
      await expect(
        generateStructuredAgentResponse({
          manager,
          agentConfig: {
            provider: "claude",
            model: CLAUDE_TEST_MODEL,
            cwd,
            title: "Stalled Generation Test",
            internal: true,
          },
          persistSession: false,
          prompt: "Return JSON with a short message.",
          schema: z.object({ message: z.string() }),
          maxRetries: 0,
          timeoutMs: 20000,
        }),
      ).rejects.toBeInstanceOf(StructuredAgentTimeoutError);
    } finally {
      clearInterval(watcher);
      await sinkhole.close();
    }

    // SIGTERM then SIGKILL, then the OS has to reap.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after = providerCliPids();

    expect(spawned.size).toBeGreaterThan(0);
    expect([...spawned].filter((pid) => after.has(pid))).toEqual([]);
  }, 120000);
});
