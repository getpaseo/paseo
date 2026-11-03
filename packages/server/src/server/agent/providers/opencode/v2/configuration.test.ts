import { describe, expect, test } from "vitest";

import {
  features,
  permissionRules,
  requiresDedicatedV2Server,
  sessionServerRequest,
} from "./configuration.js";

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

describe("OpenCode v2 server scope", () => {
  const config = { provider: "opencode", cwd: "/tmp/project" };
  const identity = { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" };
  const launch = { agentId: "agent", workspaceId: "wks_a", env: identity };

  test("shared and workspace scopes route an ordinary session by its workspace", () => {
    expect(sessionServerRequest({ config, launch, scope: "shared" })).toEqual({
      workspaceId: "wks_a",
    });
    expect(sessionServerRequest({ config, launch, scope: "workspace" })).toEqual({
      workspaceId: "wks_a",
    });
  });

  test("the agent scope gives every session its own helper with the agent's identity", () => {
    expect(sessionServerRequest({ config, launch, scope: "agent" })).toEqual({
      env: identity,
      dedicated: true,
      workspaceId: "wks_a",
    });
  });

  test("a session that needs isolation gets its own helper under the workspace scope", () => {
    const env = { ...identity, CUSTOM_FLAG: "1" };
    expect(
      sessionServerRequest({ config, launch: { ...launch, env }, scope: "workspace" }),
    ).toEqual({ env, dedicated: true, workspaceId: "wks_a" });
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
