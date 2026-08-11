import { describe, expect, test } from "vitest";
import {
  applyManagedMcpServerPatch,
  redactManagedMcpServers,
  resolveManagedMcpServers,
} from "./managed-mcp-config.js";

describe("managed MCP config", () => {
  test("preserves an existing direct secret without exposing it", () => {
    const servers = applyManagedMcpServerPatch({
      current: {
        hub: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: { source: "value", value: "private-token" } },
        },
      },
      upsert: {
        hub: {
          type: "http",
          url: "https://mcp.example.test/v2",
          headers: { Authorization: { source: "existing" } },
        },
      },
      remove: [],
    });

    expect(servers.hub).toMatchObject({
      url: "https://mcp.example.test/v2",
      headers: { Authorization: { source: "value", value: "private-token" } },
    });
    expect(redactManagedMcpServers(servers)).toEqual({
      hub: {
        type: "http",
        url: "https://mcp.example.test/v2",
        headers: { Authorization: { source: "value", configured: true } },
      },
    });
  });

  test("rejects preserving a secret that does not exist", () => {
    expect(() =>
      applyManagedMcpServerPatch({
        current: {},
        upsert: {
          hub: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: { source: "existing" } },
          },
        },
        remove: [],
      }),
    ).toThrow("cannot preserve missing header value 'Authorization'");
  });

  test("resolves enabled servers and lets session config use environment references", () => {
    expect(
      resolveManagedMcpServers(
        {
          hub: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: { source: "env", name: "MCP_TOKEN" } },
          },
          disabled: {
            type: "stdio",
            command: "disabled-server",
            enabled: false,
          },
        },
        { MCP_TOKEN: "runtime-token" },
      ),
    ).toEqual({
      hub: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "runtime-token" },
      },
    });
  });

  test("reports a missing environment variable without including another secret", () => {
    expect(() =>
      resolveManagedMcpServers(
        {
          hub: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: {
              Authorization: { source: "env", name: "MCP_TOKEN" },
              "x-private": { source: "value", value: "do-not-report" },
            },
          },
        },
        {},
      ),
    ).toThrow("requires environment variable 'MCP_TOKEN'");
  });

  test("rejects URL credentials and strips them from defensive redaction", () => {
    const serverWithCredentials = {
      type: "http" as const,
      url: "https://user:private-token@mcp.example.test/mcp",
    };

    expect(() => resolveManagedMcpServers({ hub: serverWithCredentials })).toThrow(
      "URL cannot include credentials",
    );
    expect(redactManagedMcpServers({ hub: serverWithCredentials })).toEqual({
      hub: {
        type: "http",
        url: "https://mcp.example.test/mcp",
      },
    });
  });

  test("skips session-owned names before resolving host environment references", () => {
    expect(
      resolveManagedMcpServers(
        {
          shared: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: { source: "env", name: "MISSING_TOKEN" } },
          },
          hub: { type: "stdio", command: "hub" },
        },
        {},
        ["shared"],
      ),
    ).toEqual({ hub: { type: "stdio", command: "hub" } });
  });

  test("removes named servers", () => {
    expect(
      applyManagedMcpServerPatch({
        current: {
          hub: { type: "stdio", command: "hub" },
          keep: { type: "stdio", command: "keep" },
        },
        upsert: undefined,
        remove: ["hub"],
      }),
    ).toEqual({ keep: { type: "stdio", command: "keep" } });
  });

  test("limits host servers and per-server secret entries", () => {
    const tooManyServers = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `server-${index}`,
        { type: "stdio" as const, command: "mcp-server" },
      ]),
    );
    expect(() =>
      applyManagedMcpServerPatch({ current: {}, upsert: tooManyServers, remove: [] }),
    ).toThrow("at most 64 managed MCP servers");

    const tooManyHeaders = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `x-header-${index}`,
        { source: "env" as const, name: `MCP_VALUE_${index}` },
      ]),
    );
    expect(() =>
      applyManagedMcpServerPatch({
        current: {},
        upsert: {
          hub: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: tooManyHeaders,
          },
        },
        remove: [],
      }),
    ).toThrow("at most 64 header entries");
  });
});
