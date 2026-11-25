import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface HttpMcpOptions {
  token: string;
  /** Tool `marker` returns this text and advertises it in its description. */
  marker: string;
  instructions?: string;
}

/** An authenticated Streamable HTTP MCP server, shaped like Hub's execution endpoint. */
export class HttpMcpFixture {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(options: HttpMcpOptions): Promise<HttpMcpFixture> {
    let fixture!: HttpMcpFixture;
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        response.writeHead(401).end();
        return;
      }
      const id = request.headers["mcp-session-id"];
      const existing = typeof id === "string" ? fixture.transports.get(id) : undefined;
      if (existing) {
        void existing.handleRequest(request, response);
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          fixture.transports.set(sessionId, transport);
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
        { description: `Return ${options.marker}`, inputSchema: {} },
        async () => ({ content: [{ type: "text", text: options.marker }] }),
      );
      void mcp.connect(transport).then(() => transport.handleRequest(request, response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixture = new HttpMcpFixture(
      server,
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    );
    return fixture;
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
