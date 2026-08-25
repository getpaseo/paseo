import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "../opencode-v2-agent.js";
import { reconcileOpenCodeV2McpServers, toOpenCodeV2McpConfig } from "./mcp-config.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./test-utils/test-opencode-v2-harness.js";

const DIRECTORY = "/workspace/repo";
const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function settledClient(
  servers: Array<{ name: string; status: { status: string; error?: string } }>,
): TestOpenCodeV2Client {
  const client = new TestOpenCodeV2Client();
  client.mcpListImplementation = async () => ({
    location: {
      directory: DIRECTORY,
      project: { id: "project-1", directory: DIRECTORY, canonical: DIRECTORY },
    },
    data: servers,
  });
  return client;
}

describe("toOpenCodeV2McpConfig", () => {
  test("maps a stdio server to a local config with command and env vars", () => {
    expect(
      toOpenCodeV2McpConfig({
        type: "stdio",
        command: "node",
        args: ["/tmp/op2-echo-mcp.mjs"],
        env: { OP2_PROBE: "env-ok" },
      }),
    ).toEqual({
      type: "local",
      command: ["node", "/tmp/op2-echo-mcp.mjs"],
      environment: { OP2_PROBE: "env-ok" },
    });
  });

  test("maps a stdio server without env to a local config without environment", () => {
    expect(
      toOpenCodeV2McpConfig({
        type: "stdio",
        command: "node",
        args: ["/tmp/op2-echo-mcp.mjs"],
      }),
    ).toEqual({
      type: "local",
      command: ["node", "/tmp/op2-echo-mcp.mjs"],
    });
  });

  test("maps an http server to a remote config with headers", () => {
    expect(
      toOpenCodeV2McpConfig({
        type: "http",
        url: "http://127.0.0.1:3000",
        headers: { Authorization: "Bearer token" },
      }),
    ).toEqual({
      type: "remote",
      url: "http://127.0.0.1:3000",
      headers: { Authorization: "Bearer token" },
    });
  });

  test("maps an sse server to a remote config (v2 has no separate sse path)", () => {
    expect(
      toOpenCodeV2McpConfig({
        type: "sse",
        url: "http://127.0.0.1:3000/sse",
      }),
    ).toEqual({
      type: "remote",
      url: "http://127.0.0.1:3000/sse",
    });
  });
});

describe("reconcileOpenCodeV2McpServers", () => {
  test("adds and connects a configured stdio server scoped to the session directory", async () => {
    const client = settledClient([{ name: "echo-server", status: { status: "connected" } }]);

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "echo-server": { type: "stdio", command: "node", args: ["/tmp/op2-echo-mcp.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toEqual([]);
    expect(client.calls.mcpAdd).toEqual([
      {
        server: "echo-server",
        location: { directory: DIRECTORY },
        config: { type: "local", command: ["node", "/tmp/op2-echo-mcp.mjs"] },
      },
    ]);
    expect(client.calls.mcpConnect).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
    expect(client.calls.mcpRemove).toEqual([]);
  });

  test("maps stdio env vars into the local config environment", async () => {
    const client = settledClient([{ name: "env-server", status: { status: "connected" } }]);

    await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "env-server": {
          type: "stdio",
          command: "node",
          args: ["/tmp/op2-env-mcp.mjs"],
          env: { OP2_PROBE: "env-ok" },
        },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(client.calls.mcpAdd).toEqual([
      {
        server: "env-server",
        location: { directory: DIRECTORY },
        config: {
          type: "local",
          command: ["node", "/tmp/op2-env-mcp.mjs"],
          environment: { OP2_PROBE: "env-ok" },
        },
      },
    ]);
  });

  test("maps http and sse servers to the remote config path", async () => {
    const client = settledClient([
      { name: "echo-http", status: { status: "connected" } },
      { name: "echo-sse", status: { status: "connected" } },
    ]);

    await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "echo-http": { type: "http", url: "http://127.0.0.1:3000" },
        "echo-sse": { type: "sse", url: "http://127.0.0.1:3000/sse" },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(client.calls.mcpAdd).toEqual([
      {
        server: "echo-http",
        location: { directory: DIRECTORY },
        config: { type: "remote", url: "http://127.0.0.1:3000" },
      },
      {
        server: "echo-sse",
        location: { directory: DIRECTORY },
        config: { type: "remote", url: "http://127.0.0.1:3000/sse" },
      },
    ]);
  });

  test("treats an already-present server as success (idempotent re-inject)", async () => {
    const client = settledClient([{ name: "echo-server", status: { status: "connected" } }]);
    client.mcpAddError = new Error("MCP server already exists: echo-server");

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "echo-server": { type: "stdio", command: "node", args: ["/tmp/op2-echo-mcp.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toEqual([]);
    // The server is still connected after the idempotent re-add.
    expect(client.calls.mcpConnect).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
  });

  test("a failed add is graceful: no throw, diagnostic returned", async () => {
    const client = settledClient([]);
    client.mcpAddError = new Error("boom");

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "bad-server": { type: "stdio", command: "node", args: ["/tmp/does-not-exist.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("bad-server");
    expect(client.calls.mcpConnect).toEqual([]);
  });

  test("a failed connect is graceful: no throw, diagnostic returned", async () => {
    const client = settledClient([]);
    client.mcpConnectError = new Error("connection refused");

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "bad-server": { type: "stdio", command: "node", args: ["/tmp/does-not-exist.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("bad-server");
  });

  test("a server whose status is failed surfaces a diagnostic", async () => {
    const client = settledClient([
      {
        name: "bad-server",
        status: { status: "failed", error: "MCP error -32000: Connection closed" },
      },
    ]);

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "bad-server": { type: "stdio", command: "node", args: ["/tmp/does-not-exist.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("bad-server");
    expect(diagnostics[0]).toContain("Connection closed");
  });

  test("removes a server that is present but no longer configured", async () => {
    const client = settledClient([
      { name: "echo-server", status: { status: "connected" } },
      { name: "other-server", status: { status: "connected" } },
    ]);

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: {
        "other-server": { type: "stdio", command: "node", args: ["/tmp/other.mjs"] },
      },
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toEqual([]);
    expect(client.calls.mcpRemove).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
  });

  test("an empty config removes every server present on the server", async () => {
    const client = settledClient([{ name: "echo-server", status: { status: "connected" } }]);

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: undefined,
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toEqual([]);
    expect(client.calls.mcpAdd).toEqual([]);
    expect(client.calls.mcpConnect).toEqual([]);
    expect(client.calls.mcpRemove).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
  });

  test("removing an already-gone server is a clean no-op", async () => {
    const client = settledClient([{ name: "echo-server", status: { status: "connected" } }]);
    client.mcpRemoveError = new Error("MCP server not found: echo-server");

    const diagnostics = await reconcileOpenCodeV2McpServers({
      client,
      mcpServers: undefined,
      directory: DIRECTORY,
      logger: createTestLogger(),
    });

    expect(diagnostics).toEqual([]);
    expect(client.calls.mcpRemove).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
  });
});

describe("OpenCodeV2AgentClient MCP injection", () => {
  test("createSession injects configured MCP servers before the first prompt", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    openCode.mcpListImplementation = async () => ({
      location: {
        directory: DIRECTORY,
        project: { id: "project-1", directory: DIRECTORY, canonical: DIRECTORY },
      },
      data: [{ name: "echo-server", status: { status: "connected" } }],
    });
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: DIRECTORY,
      model: TEST_MODEL,
      mcpServers: {
        "echo-server": { type: "stdio", command: "node", args: ["/tmp/op2-echo-mcp.mjs"] },
      },
    });

    expect(session).toBeDefined();
    expect(openCode.calls.mcpAdd).toEqual([
      {
        server: "echo-server",
        location: { directory: DIRECTORY },
        config: { type: "local", command: ["node", "/tmp/op2-echo-mcp.mjs"] },
      },
    ]);
    expect(openCode.calls.mcpConnect).toEqual([
      { server: "echo-server", location: { directory: DIRECTORY } },
    ]);
  });

  test("a misconfigured MCP server does not break session creation and surfaces a diagnostic", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    openCode.mcpAddError = new Error("boom");
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: DIRECTORY,
      model: TEST_MODEL,
      mcpServers: {
        "bad-server": { type: "stdio", command: "node", args: ["/tmp/does-not-exist.mjs"] },
      },
    });

    // Session creation still succeeds; the diagnostic is emitted on the first turn.
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("say hi", {});

    const errorItems = events.filter(
      (event) => event.type === "timeline" && event.item.type === "error",
    );
    expect(errorItems).toHaveLength(1);
    expect(errorItems[0]!.item.message).toContain("bad-server");
  });
});
