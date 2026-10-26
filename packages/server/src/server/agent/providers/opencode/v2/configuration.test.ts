import { describe, expect, test } from "vitest";

import { features, permissionRules, requiresDedicatedV2Server } from "./configuration.js";

describe("OpenCode v2 permission rules", () => {
  test("maps authored native permissions and exact injected MCP grants", () => {
    expect(
      permissionRules({
        provider: "opencode",
        cwd: "/tmp/project",
        providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
        toolPolicy: { preapproved: [{ server: "paseo.host", tool: "read/info" }] },
      }),
    ).toEqual([
      { action: "paseo_host_read_info", resource: "*", effect: "allow" },
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  });
});

describe("OpenCode v2 helper isolation", () => {
  test("shares the helper for agent-identity environment only", () => {
    expect(
      requiresDedicatedV2Server(
        { provider: "opencode", cwd: "/tmp/project" },
        { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
      ),
    ).toBe(false);
  });

  test("dedicates a helper for any other process environment", () => {
    expect(
      requiresDedicatedV2Server(
        { provider: "opencode", cwd: "/tmp/project" },
        { agentId: "agent", env: { CUSTOM_FLAG: "1" } },
      ),
    ).toBe(true);
  });

  test("dedicates a helper when the session carries custom MCP", () => {
    expect(
      requiresDedicatedV2Server({
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      }),
    ).toBe(true);
  });
});

describe("OpenCode v2 features", () => {
  test("reports the auto-accept toggle from the session value", () => {
    expect(features({ provider: "opencode", cwd: "/tmp/project" })).toEqual([
      { type: "toggle", id: "auto_accept", label: "Auto-accept", value: false },
    ]);
    expect(
      features({
        provider: "opencode",
        cwd: "/tmp/project",
        featureValues: { auto_accept: true },
      }),
    ).toEqual([{ type: "toggle", id: "auto_accept", label: "Auto-accept", value: true }]);
  });
});
