import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridge = fileURLToPath(new URL("./mcp-unix-bridge-cli.ts", import.meta.url));
const bridgeArgs = ["--import", import.meta.resolve("tsx"), bridge];
const image = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};
const tool = {
  name: "read",
  description: "Read the caller's workspace",
  inputSchema: { type: "object", properties: {} },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-mcp-"));
  const socketPath = join(directory, "daemon.sock");
  const seen: Array<{
    message: JSONRPCMessage;
    agentId: string | null;
    protocol: string | string[] | undefined;
  }> = [];
  let held: ServerResponse | undefined;
  const { promise: heldStarted, resolve: heldResolve } = Promise.withResolvers<void>();
  const { promise: heldClosed, resolve: closedResolve } = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!("method" in message)) {
      response.writeHead(202).end();
      return;
    }
    const agentId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
      "callerAgentId",
    );
    seen.push({ message, agentId, protocol: request.headers["mcp-protocol-version"] });
    const reply = (result: unknown, sse = false) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "id" in message ? message.id : undefined,
        result,
      });
      if (!sse) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(body);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const bytes = Buffer.from(`event: message\r\ndata: ${body}\r\n\r\n`);
      // Split inside UTF-8 and across SSE fields to exercise stream decoding.
      for (let i = 0; i < bytes.length; i += 7) response.write(bytes.subarray(i, i + 7));
      response.end();
    };
    if (message.method === "initialize") {
      reply({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    } else if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else if (message.method === "tools/list") {
      reply({ tools: [tool] });
    } else if (message.method === "tools/call") {
      if (message.params?.name === "hold") {
        held = response;
        response.once("close", closedResolve);
        heldResolve();
      } else if (message.params?.name === "drop") {
        request.socket.destroy();
      } else if (message.params?.name === "error") {
        reply({ content: [{ type: "text", text: "page missing" }], isError: true }, true);
      } else {
        reply(
          {
            content: [{ type: "text", text: "Logged in ✓ 🐈" }, image],
            structuredContent: { workspace: agentId },
          },
          true,
        );
      }
    } else {
      response.writeHead(405).end();
    }
  });
  server.listen(socketPath);
  await once(server, "listening");
  const clients: Client[] = [];
  return {
    socketPath,
    seen,
    heldStarted,
    heldClosed,
    async connect(agentId = "agent-one") {
      const client = new Client({ name: "bridge-test", version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [...bridgeArgs, "--socket", socketPath, "--agent-id", agentId],
        stderr: "pipe",
      });
      clients.push(client);
      await client.connect(transport);
      return client;
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      held?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "stdio discovery and calls preserve schemas, UTF-8, images, errors, and caller scope",
  { timeout: 15_000 },
  async () => {
    const daemon = await fixture();
    try {
      const one = await daemon.connect("workspace-one");
      const two = await daemon.connect("workspace-two");
      assert.deepEqual((await one.listTools()).tools, [tool]);
      const result = await one.callTool({ name: "read", arguments: {} });
      assert.deepEqual(result, {
        content: [{ type: "text", text: "Logged in ✓ 🐈" }, image],
        structuredContent: { workspace: "workspace-one" },
      });
      assert.deepEqual((await two.callTool({ name: "read", arguments: {} })).structuredContent, {
        workspace: "workspace-two",
      });
      assert.deepEqual(await one.callTool({ name: "error", arguments: {} }), {
        content: [{ type: "text", text: "page missing" }],
        isError: true,
      });
      const initialize = daemon.seen.find(
        (entry) => ("method" in entry.message ? entry.message.method : undefined) === "initialize",
      );
      const listing = daemon.seen.find(
        (entry) => ("method" in entry.message ? entry.message.method : undefined) === "tools/list",
      );
      assert.ok(listing && initialize && "method" in initialize.message);
      assert.equal(listing.protocol, initialize.message.params?.protocolVersion);
    } finally {
      await daemon.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a slow call does not block another call and cancellation closes its HTTP request",
  { timeout: 15_000 },
  async () => {
    const daemon = await fixture();
    try {
      const client = await daemon.connect();
      const controller = new AbortController();
      const waiting = client
        .callTool({ name: "hold", arguments: {} }, undefined, { signal: controller.signal })
        .catch((error) => error);
      await daemon.heldStarted;
      const result = await client.callTool({ name: "read", arguments: {} });
      assert.deepEqual(result.structuredContent, { workspace: "agent-one" });
      controller.abort();
      assert.ok((await waiting) instanceof Error);
      await daemon.heldClosed;
      assert.equal(
        daemon.seen.filter(
          (entry) =>
            ("method" in entry.message ? entry.message.params?.name : undefined) === "hold",
        ).length,
        1,
      );
    } finally {
      await daemon.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a lost reply is reported without replaying an action",
  { timeout: 15_000 },
  async () => {
    const daemon = await fixture();
    try {
      const client = await daemon.connect();
      await assert.rejects(client.callTool({ name: "drop", arguments: {} }), /Paseo Unix MCP/);
      assert.equal(
        daemon.seen.filter(
          (entry) =>
            ("method" in entry.message ? entry.message.params?.name : undefined) === "drop",
        ).length,
        1,
      );
      assert.deepEqual((await client.listTools()).tools, [tool]);
    } finally {
      await daemon.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "closing stdin ends the helper without a forced kill",
  { timeout: 15_000 },
  async () => {
    const child = spawn(
      process.execPath,
      [...bridgeArgs, "--socket", "/tmp/unused-paseo-test.sock", "--agent-id", "test"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.resume();
    child.stderr.resume();
    const exited = once(child, "exit");
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  },
);
