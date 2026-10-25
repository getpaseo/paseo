import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { OmpHarness } from "./test-utils/omp-harness.js";
import { OmpMcpBridge } from "./mcp-bridge.js";
import type { PaseoToolCatalog } from "../../tools/types.js";

const fixture = fileURLToPath(new URL("./test-utils/echo-mcp-server.mjs", import.meta.url));
const healthy = { type: "stdio" as const, command: process.execPath, args: [fixture] };

describe("OMP MCP host tools", () => {
  test("registers a stdio MCP tool and proxies its call", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness();
    await omp.start({ mcpServers: { local: healthy } });
    try {
      const tool = omp.registeredHostTools().at(-1)?.[0];
      expect(tool?.name).toMatch(/^mcp_local__echo_secret/);
      const runtime = omp.runtime();
      const result = runtime.nextHostToolResult();
      runtime.emit({
        type: "host_tool_call",
        id: "call-1",
        toolCallId: "tool-1",
        toolName: tool!.name,
        arguments: { word: "hello" },
      });
      expect(await result).toMatchObject({
        id: "call-1",
        result: { content: [{ type: "text", text: "MANGO:hello" }] },
      });
      const failed = runtime.nextHostToolResult();
      runtime.emit({
        type: "host_tool_call",
        id: "call-2",
        toolCallId: "tool-2",
        toolName: tool!.name,
        arguments: { word: "FAIL" },
      });
      expect(await failed).toMatchObject({
        id: "call-2",
        isError: true,
        result: { isError: true, content: [{ type: "text", text: "fixture failure" }] },
      });
      runtime.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: tool!.name,
        args: { word: "hello" },
      });
      runtime.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: tool!.name,
        result: { content: [{ type: "text", text: "MANGO:hello" }] },
      });
      expect(omp.timeline().at(-1)).toMatchObject({
        type: "tool_call",
        name: "local / echo_secret",
        status: "completed",
        detail: {
          type: "unknown",
          input: { word: "hello" },
          output: { content: [{ type: "text", text: "MANGO:hello" }] },
        },
      });
      runtime.emit({
        type: "tool_execution_start",
        toolCallId: "native-1",
        toolName: "mcp__native_echo_secret",
        args: { word: "native" },
      });
      runtime.emit({
        type: "tool_execution_end",
        toolCallId: "native-1",
        toolName: "mcp__native_echo_secret",
        result: { content: [{ type: "text", text: "native result" }] },
      });
      expect(omp.timeline().at(-1)).toMatchObject({
        type: "tool_call",
        name: "mcp__native_echo_secret",
        detail: { type: "unknown", input: { word: "native" } },
      });
    } finally {
      await omp.close();
    }
  });

  test("skips a failed server and registers a healthy one", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness();
    await omp.start({
      mcpServers: { broken: { type: "stdio", command: "/nonexistent/omp-mcp" }, local: healthy },
    });
    try {
      expect(
        omp
          .registeredHostTools()
          .at(-1)
          ?.map((tool) => tool.name),
      ).toEqual([expect.stringMatching(/^mcp_local__echo_secret/)]);
      const runtime = omp.runtime();
      const result = runtime.nextHostToolResult();
      runtime.emit({
        type: "host_tool_call",
        id: "healthy-call",
        toolCallId: "healthy-tool",
        toolName: omp.registeredHostTools()[0]![0]!.name,
        arguments: { word: "healthy" },
      });
      expect(await result).toMatchObject({
        result: { content: [{ type: "text", text: "MANGO:healthy" }] },
      });
    } finally {
      await omp.close();
    }
  });

  test("starts with a healthy server when another never answers initialize", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness();
    const started = Date.now();
    await omp.start({
      mcpServers: {
        silent: {
          type: "stdio",
          command: process.execPath,
          args: ["-e", "process.stdin.resume();setInterval(()=>{},1<<30)"],
        },
        local: healthy,
      },
    });
    try {
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(
        omp
          .registeredHostTools()
          .at(-1)
          ?.map((tool) => tool.name),
      ).toEqual([expect.stringMatching(/^mcp_local__echo_secret/)]);
    } finally {
      await omp.close();
    }
  }, 80_000);

  test("passes runtime and launch env to stdio, then applies server env", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness({
      runtimeEnv: { OMP_MCP_RUNTIME_ENV: "runtime", OMP_MCP_PRECEDENCE: "runtime" },
    });
    await omp.start(
      {
        mcpServers: {
          local: { ...healthy, env: { OMP_MCP_PRECEDENCE: "server" } },
        },
      },
      undefined,
      { PASEO_AGENT_ID: "agent-123", OMP_MCP_PRECEDENCE: "launch" },
    );
    try {
      const runtime = omp.runtime();
      const result = runtime.nextHostToolResult();
      runtime.emit({
        type: "host_tool_call",
        id: "env-call",
        toolCallId: "env-tool",
        toolName: omp.registeredHostTools()[0]![0]!.name,
        arguments: { word: "ENV" },
      });
      expect(await result).toMatchObject({
        result: {
          content: [
            {
              type: "text",
              text: '{"runtime":"runtime","agent":"agent-123","precedence":"server"}',
            },
          ],
        },
      });
    } finally {
      await omp.close();
    }
  });

  test("replays the bridge label and Codex-style detail after archive", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness();
    await omp.start({ mcpServers: { local: healthy } });
    try {
      const exposedName = omp.registeredHostTools()[0]![0]!.name;
      const persisted = omp.persistence();
      expect(persisted?.metadata?.bridgedTools).toEqual([
        [exposedName, { server: "local", tool: "echo_secret" }],
      ]);
      const directory = await mkdtemp(join(tmpdir(), "omp-mcp-history-"));
      const sessionFile = join(directory, "session.jsonl");
      await writeFile(
        sessionFile,
        [
          { type: "session", id: "root", parentId: null },
          {
            type: "message",
            id: "call",
            parentId: "root",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: exposedName,
                  arguments: { word: "REVIEW" },
                },
              ],
            },
          },
          {
            type: "message",
            id: "result",
            parentId: "call",
            message: {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: exposedName,
              content: [{ type: "text", text: "MANGO:REVIEW" }],
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const events = await omp.replayHistory({ ...persisted!, nativeHandle: sessionFile });
      expect(events.findLast((event) => event.type === "timeline")?.item).toMatchObject({
        type: "tool_call",
        name: "local / echo_secret",
        detail: {
          type: "unknown",
          input: { word: "REVIEW" },
          output: { content: [{ type: "text", text: "MANGO:REVIEW" }] },
        },
      });
    } finally {
      await omp.close();
    }
  });

  test("registers Paseo and MCP tools in the same replacement set", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const paseoTools: PaseoToolCatalog = {
      tools: new Map([
        [
          "create_agent",
          {
            name: "create_agent",
            description: "Create an agent",
            handler: async () => ({ content: [] }),
          },
        ],
      ]),
      getTool: () => undefined,
      executeTool: async () => ({ content: [] }),
    };
    const omp = new OmpHarness();
    await omp.start({ mcpServers: { local: healthy } }, paseoTools);
    try {
      expect(omp.registeredHostTools()).toHaveLength(1);
      expect(omp.registeredHostTools()[0]?.map((tool) => tool.name)).toEqual([
        "create_agent",
        expect.stringMatching(/^mcp_local__echo_secret_/),
      ]);
    } finally {
      await omp.close();
    }
  });

  test("registers MCP tools after resume and crash relaunch", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const omp = new OmpHarness();
    await omp.resume(
      { user: { id: "user-1", text: "hello" }, assistant: { id: "assistant-1", text: "hi" } },
      { mcpServers: { local: healthy } },
    );
    try {
      expect(omp.registeredHostTools().at(-1)?.[0]?.name).toMatch(/^mcp_local__echo_secret/);
      omp.processExit("crashed");
      await omp.startTurn("again");
      // The relaunch spawns a new runtime and MCP child; on a loaded Windows
      // runner that has taken longer than vi.waitFor's default one second.
      await vi.waitFor(
        () => {
          expect(omp.runtimeSessions()).toHaveLength(2);
          expect(omp.registeredHostTools().at(-1)?.[0]?.name).toMatch(/^mcp_local__echo_secret/);
        },
        { timeout: 10_000 },
      );
    } finally {
      await omp.close();
    }
  });

  test("closes the stdio MCP child with the session", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const directory = await mkdtemp(join(tmpdir(), "omp-mcp-pid-"));
    const pidFile = join(directory, "pid");
    const omp = new OmpHarness();
    await omp.start({ mcpServers: { local: { ...healthy, env: { OMP_MCP_PID_FILE: pidFile } } } });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await omp.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("cancels an in-flight MCP call when OMP cancels its host tool", async () => {
    await mkdir("/tmp/paseo-omp-agent-test", { recursive: true });
    const directory = await mkdtemp(join(tmpdir(), "omp-mcp-cancel-"));
    const waitFile = join(directory, "waiting");
    const cancelFile = join(directory, "cancelled");
    const omp = new OmpHarness();
    await omp.start({
      mcpServers: {
        local: {
          ...healthy,
          env: { OMP_MCP_WAIT_FILE: waitFile, OMP_MCP_CANCEL_FILE: cancelFile },
        },
      },
    });
    try {
      const runtime = omp.runtime();
      runtime.emit({
        type: "host_tool_call",
        id: "wait-call",
        toolCallId: "wait-tool",
        toolName: omp.registeredHostTools()[0]![0]!.name,
        arguments: { word: "WAIT" },
      });
      await vi.waitFor(async () => expect(await readFile(waitFile, "utf8")).toBe("waiting"));
      runtime.emit({ type: "host_tool_cancel", id: "cancel-1", targetId: "wait-call" });
      await vi.waitFor(async () => expect(await readFile(cancelFile, "utf8")).toBe("cancelled"));
      expect(runtime.hostToolResults).toEqual([]);
    } finally {
      await omp.close();
    }
  });

  test("managed streams never follow a redirect with the credential", async () => {
    const redirecting = await startRedirectingMcpServer();
    const credential = "Bearer redirect-test-credential";
    try {
      const bridge = await OmpMcpBridge.connect(
        { memory: { type: "http", url: `http://127.0.0.1:${redirecting.port}/mcp` } },
        process.cwd(),
        pino({ level: "silent" }),
        {},
        { memory: credential },
        () => undefined,
      );
      const sawGet = () => redirecting.seen.some((entry) => entry.method === "GET");
      await vi.waitFor(() => expect(sawGet()).toBe(true));
      // A redirect follow is issued right after the 302 arrives; this round trip on the same
      // loopback server is queued behind it, so no timed wait is needed.
      await fetch(`http://127.0.0.1:${redirecting.port}/sync`);
      await bridge.close();
      expect(redirecting.seen.filter((entry) => entry.path === "/leak")).toEqual([]);
      expect(
        redirecting.seen.filter((entry) => entry.authorization === credential).length,
      ).toBeGreaterThan(0);
    } finally {
      await redirecting.close();
    }
  });

  test("a managed error result is generic while an ordinary server's error is untouched", async () => {
    const server = await startRedirectingMcpServer();
    const credential = "Bearer error-result-credential";
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const logger = pino({ level: "silent" });
    try {
      const managed = await OmpMcpBridge.connect(
        { memory: { type: "http", url } },
        process.cwd(),
        logger,
        {},
        { memory: credential },
        () => undefined,
      );
      const ordinary = await OmpMcpBridge.connect(
        { memory: { type: "http", url, headers: { Authorization: "Bearer ordinary" } } },
        process.cwd(),
        logger,
        {},
      );
      try {
        const name = managed.definitions[0]!.name;
        const failed = await managed.execute(name, {}, new AbortController().signal);
        expect(failed.isError).toBe(true);
        expect(JSON.stringify(failed)).not.toContain(credential);
        expect(JSON.stringify(failed)).toContain("failed");
        const echoed = await ordinary.execute(
          ordinary.definitions[0]!.name,
          {},
          new AbortController().signal,
        );
        expect(JSON.stringify(echoed)).toContain("Synthetic service rejected Bearer ordinary");
      } finally {
        await managed.close();
        await ordinary.close();
      }
    } finally {
      await server.close();
    }
  });
});

interface SeenRequest {
  method: string;
  path: string;
  authorization?: string;
}

function rpcResult(
  message: { method: string; params?: { protocolVersion?: string } },
  authorization?: string,
) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "redirecting", version: "1" },
    };
  }
  if (message.method === "tools/call") {
    return {
      isError: true,
      content: [{ type: "text", text: `Synthetic service rejected ${authorization}` }],
    };
  }
  return { tools: [{ name: "probe", inputSchema: { type: "object" } }] };
}

function answerJsonRpc(res: ServerResponse, body: string, authorization?: string): void {
  const message = body ? JSON.parse(body) : {};
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result: rpcResult(message, authorization) }),
  );
}

function handleRedirectingRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "GET" && req.url === "/mcp") {
    res.writeHead(302, { location: "/leak" });
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () =>
    answerJsonRpc(res, Buffer.concat(chunks).toString("utf8"), req.headers.authorization),
  );
}

// A streamable HTTP MCP server whose GET stream answers with a same-origin redirect.
async function startRedirectingMcpServer() {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization,
    });
    handleRedirectingRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
