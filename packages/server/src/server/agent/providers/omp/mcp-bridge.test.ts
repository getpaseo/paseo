import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OmpHarness } from "./test-utils/omp-harness.js";
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
      await vi.waitFor(() => {
        expect(omp.runtimeSessions()).toHaveLength(2);
        expect(omp.registeredHostTools().at(-1)?.[0]?.name).toMatch(/^mcp_local__echo_secret/);
      });
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
});
