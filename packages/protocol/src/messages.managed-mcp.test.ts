import { describe, expect, test } from "vitest";
import {
  DaemonMcpServerTestRequestSchema,
  DaemonMcpServerTestResponseSchema,
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
} from "./messages.js";

describe("managed MCP protocol", () => {
  test("accepts redacted daemon config and secret-preserving patches", () => {
    const config = MutableDaemonConfigSchema.parse({
      mcp: {
        injectIntoAgents: true,
        servers: {
          hub: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: {
              Authorization: { source: "value", configured: true },
              "x-tenant": { source: "env", name: "MCP_TENANT" },
            },
          },
        },
      },
    });
    const patch = MutableDaemonConfigPatchSchema.parse({
      upsertMcpServers: {
        hub: {
          type: "http",
          url: "https://mcp.example.test/v2",
          headers: {
            Authorization: { source: "existing" },
          },
        },
      },
      removeMcpServers: ["old-hub"],
    });

    expect(config.mcp.servers?.hub).toMatchObject({ type: "http" });
    expect(patch.removeMcpServers).toEqual(["old-hub"]);
  });

  test("accepts namespaced connection-test messages", () => {
    expect(
      DaemonMcpServerTestRequestSchema.parse({
        type: "daemon.mcp.server.test.request",
        requestId: "request-1",
        name: "hub",
      }),
    ).toMatchObject({ name: "hub" });
    expect(
      DaemonMcpServerTestResponseSchema.parse({
        type: "daemon.mcp.server.test.response",
        payload: {
          requestId: "request-1",
          name: "hub",
          status: "success",
          latencyMs: 12,
          toolCount: 4,
        },
      }),
    ).toMatchObject({ payload: { status: "success", toolCount: 4 } });
  });

  test("rejects unsafe names, transports, and environment references", () => {
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertMcpServers: {
          "../hub": { type: "http", url: "https://mcp.example.test/mcp" },
        },
      }),
    ).toThrow();
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertMcpServers: {
          hub: { type: "http", url: "file:///tmp/mcp" },
        },
      }),
    ).toThrow();
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertMcpServers: {
          hub: {
            type: "stdio",
            command: "mcp-server",
            env: { TOKEN: { source: "env", name: "INVALID-NAME" } },
          },
        },
      }),
    ).toThrow();
  });

  test("rejects credentials embedded in managed MCP URLs", () => {
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertMcpServers: {
          hub: { type: "http", url: "https://user:private-token@mcp.example.test/mcp" },
        },
      }),
    ).toThrow("cannot include credentials");

    expect(() =>
      MutableDaemonConfigSchema.parse({
        mcp: {
          injectIntoAgents: true,
          servers: {
            hub: { type: "sse", url: "https://user:private-token@mcp.example.test/sse" },
          },
        },
      }),
    ).toThrow("cannot include credentials");
  });
});

describe("managed agent template protocol", () => {
  test("accepts template upserts and removals", () => {
    const patch = MutableDaemonConfigPatchSchema.parse({
      upsertAgentTemplates: {
        reviewer: {
          name: "Code reviewer",
          description: "Reviews implementation changes",
          instructions: "Review the requested change and report actionable findings.",
        },
      },
      removeAgentTemplates: ["old-reviewer"],
    });

    expect(patch.upsertAgentTemplates?.reviewer?.name).toBe("Code reviewer");
    expect(patch.removeAgentTemplates).toEqual(["old-reviewer"]);
  });

  test("rejects unsafe IDs and incomplete templates", () => {
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertAgentTemplates: {
          "../reviewer": {
            name: "Reviewer",
            description: "Reviews code",
            instructions: "Review code.",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      MutableDaemonConfigPatchSchema.parse({
        upsertAgentTemplates: {
          reviewer: { name: "Reviewer", description: "Reviews code" },
        },
      }),
    ).toThrow();
  });
});
