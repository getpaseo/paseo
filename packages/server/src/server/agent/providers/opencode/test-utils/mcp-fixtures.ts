import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

interface HttpMcpOptions {
  token: string;
  /** Tool `marker` returns this text and advertises it in its description. */
  marker: string;
  instructions?: string;
  /** Tool `marker` requires a string argument with this name. */
  requiredInput?: string;
  /** Accepts each session DELETE and never answers it, like an unresponsive server. */
  holdTermination?: boolean;
  /** Accepts the client's `notifications/initialized` and never answers it. */
  holdInitialized?: boolean;
}

/** An authenticated Streamable HTTP MCP server, shaped like Hub's execution endpoint. */
export class HttpMcpFixture {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  /** Session DELETE requests left unanswered because of `holdTermination`. */
  heldTerminations = 0;
  /** Sessions that a client initialized, including expired ones. */
  initializedSessions = 0;
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(options: HttpMcpOptions): Promise<HttpMcpFixture> {
    let fixture!: HttpMcpFixture;
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        response.writeHead(401).end();
        return;
      }
      if (options.holdTermination && request.method === "DELETE") {
        fixture.heldTerminations += 1;
        return;
      }
      const body = request.method === "POST" ? await readJson(request) : undefined;
      if (options.holdInitialized && isMethod(body, "notifications/initialized")) return;
      const id = request.headers["mcp-session-id"];
      if (typeof id === "string") {
        const existing = fixture.transports.get(id);
        // The protocol answers an unknown session with 404, so the client starts a new one.
        if (existing) void existing.handleRequest(request, response, body);
        else response.writeHead(404).end();
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          fixture.transports.set(sessionId, transport);
          fixture.initializedSessions += 1;
        },
        // A client ends its session with DELETE when it closes the connection.
        onsessionclosed: (sessionId) => {
          fixture.transports.delete(sessionId);
        },
      });
      const mcp = new McpServer(
        { name: "hub", version: "1.0.0" },
        options.instructions ? { instructions: options.instructions } : {},
      );
      mcp.registerTool(
        "marker",
        {
          description: `Return ${options.marker}`,
          inputSchema: options.requiredInput ? { [options.requiredInput]: z.string() } : {},
        },
        async () => ({ content: [{ type: "text", text: options.marker }] }),
      );
      void mcp.connect(transport).then(() => transport.handleRequest(request, response, body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixture = new HttpMcpFixture(
      server,
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    );
    return fixture;
  }

  /** Forgets every session, as a server does when it restarts. */
  expireSessions(): void {
    this.transports.clear();
  }

  /** MCP client sessions that have not been terminated. */
  get openSessions(): number {
    return this.transports.size;
  }

  async close(): Promise<void> {
    await Promise.all([...this.transports.values()].map((transport) => transport.close()));
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isMethod(body: unknown, method: string): boolean {
  return typeof body === "object" && body !== null && "method" in body && body.method === method;
}

/**
 * Writes a stdio MCP server whose `env` tool returns the value of `name` in its own environment.
 * It records its pid in `<directory>/stdio-mcp.pid` so tests can prove it exited.
 */
export async function writeStdioMcpFixture(directory: string): Promise<{
  script: string;
  pidFile: string;
}> {
  const script = path.join(directory, "stdio-mcp.mjs");
  const pidFile = path.join(directory, "stdio-mcp.pid");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = new McpServer({ name: "local", version: "1.0.0" });
server.registerTool("env", { description: "Read an environment variable", inputSchema: { name: z.string() } }, async ({ name }) => ({ content: [{ type: "text", text: process.env[name] ?? "<unset>" }] }));
await server.connect(new StdioServerTransport());
`,
  );
  return { script, pidFile };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
