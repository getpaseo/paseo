import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OmpHarness } from "./test-utils/omp-harness.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
import { waitForOmpHostToolsIdle } from "./host-tools.js";

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
        name: "MCP",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "local / echo_secret",
          text: 'Input: {"word":"hello"}\nResult: MANGO:hello',
        },
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

  test("does not duplicate the injected Paseo MCP endpoint", async () => {
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
    await omp.start(
      {
        mcpServers: {
          paseo: { type: "http", url: "http://127.0.0.1:1/mcp/agents" },
          local: healthy,
        },
      },
      paseoTools,
    );
    try {
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
      await waitForOmpHostToolsIdle(runtime);
      expect(runtime.hostToolResults).toEqual([]);
    } finally {
      await omp.close();
    }
  });
});
