import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../test-utils/test-logger.js";

import { validateProviderOptions } from "./provider-options.js";
import { applyClaudeToolPolicy, ClaudeProviderOptionsSchema } from "./providers/claude/options.js";
import { applyCodexToolPolicy, CodexProviderOptionsSchema } from "./providers/codex/options.js";
import {
  buildOpenCodePermissionRules,
  OpenCodeProviderOptionsSchema,
} from "./providers/opencode/options.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { ProviderRuntime } from "./provider-connection-runtime.js";

const hubPolicy = {
  preapproved: [{ kind: "mcp" as const, server: "hub", tool: "finish_execution" }],
};

describe("provider-owned option schemas", () => {
  test("reports provider option validation through the provider request boundary", async () => {
    const runtime = new ProviderRuntime(
      buildProviderRegistry(createTestLogger()).claude.registration,
    );
    try {
      await expect(
        runtime.openSession({
          sessionId: "invalid-options",
          config: {
            cwd: "/tmp",
            env: {},
            mcpServers: {},
            settings: {},
            providerOptions: { sandbox: { network: { allowLocalBinding: "yes" } } },
            persist: false,
          },
          history: "skip",
        }),
      ).rejects.toThrow(
        "Invalid providerOptions for 'claude': providerOptions.sandbox.network.allowLocalBinding",
      );
    } finally {
      await runtime.close();
    }
  });

  test("keeps the derived provider identity in provider option request failures", async () => {
    const registration = buildProviderRegistry(createTestLogger(), {
      providerOverrides: {
        "custom-claude": { extends: "claude", label: "Custom Claude" },
      },
    })["custom-claude"].registration;
    const runtime = new ProviderRuntime(registration);
    try {
      await expect(
        runtime.openSession({
          sessionId: "invalid-derived-options",
          config: {
            cwd: "/tmp",
            env: {},
            mcpServers: {},
            settings: {},
            providerOptions: { sandbox: { network: { allowLocalBinding: "yes" } } },
            persist: false,
          },
          history: "skip",
        }),
      ).rejects.toThrow("Invalid providerOptions for 'custom-claude'");
    } finally {
      await runtime.close();
    }
  });

  test("accepts Codex native workspace-write and network policy nesting", () => {
    expect(
      CodexProviderOptionsSchema.parse({
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          writable_roots: ["/var/cache/npm"],
          network_access: false,
        },
        web_search: "disabled",
        features: {
          network_proxy: {
            enabled: true,
            domains: { "registry.npmjs.org": "allow", "*": "deny" },
          },
        },
      }),
    ).toMatchObject({
      sandbox_workspace_write: { writable_roots: ["/var/cache/npm"] },
    });
  });

  test("reports the exact invalid Codex option path", () => {
    expect(() =>
      validateProviderOptions("codex", CodexProviderOptionsSchema, {
        sandbox_workspace_write: { writable_roots: ["/tmp", 42] },
      }),
    ).toThrow("providerOptions.sandbox_workspace_write.writable_roots[1]");
  });

  test("accepts Claude permission and fail-closed sandbox settings", () => {
    expect(
      ClaudeProviderOptionsSchema.parse({
        allowedTools: ["Read"],
        disallowedTools: ["Bash(rm *)"],
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          filesystem: { denyRead: ["~/.ssh/**"] },
          network: {
            allowedDomains: ["api.anthropic.com"],
            allowLocalBinding: false,
            allowUnixSockets: ["/var/run/docker.sock"],
          },
        },
        settings: { permissions: { ask: ["Bash(*)"], deny: ["Edit(.env)"] } },
      }),
    ).toMatchObject({ sandbox: { enabled: true, failIfUnavailable: true } });
  });

  test("reports the exact invalid Claude option path", () => {
    expect(() =>
      validateProviderOptions("claude", ClaudeProviderOptionsSchema, {
        sandbox: { network: { allowLocalBinding: "yes" } },
      }),
    ).toThrow("providerOptions.sandbox.network.allowLocalBinding");
  });

  test("accepts OpenCode native permission patterns and external_directory", () => {
    expect(
      OpenCodeProviderOptionsSchema.parse({
        permission: {
          bash: { "*": "ask", "git status": "allow" },
          external_directory: { "*": "deny", "/var/cache/npm/**": "allow" },
        },
      }),
    ).toMatchObject({ permission: { bash: { "*": "ask" } } });
  });

  test("reports the exact invalid OpenCode option path", () => {
    expect(() =>
      validateProviderOptions("opencode", OpenCodeProviderOptionsSchema, {
        permission: { bash: { "git status": "sometimes" } },
      }),
    ).toThrow('providerOptions.permission.bash["git status"]');
  });

  test.each([
    ["codex", CodexProviderOptionsSchema, { cwd: "/tmp" }],
    ["claude", ClaudeProviderOptionsSchema, { hooks: {} }],
    ["opencode", OpenCodeProviderOptionsSchema, { mcp: {} }],
  ])("rejects Paseo-owned or executable %s keys", (provider, schema, options) => {
    expect(() => validateProviderOptions(provider, schema, options)).toThrow(
      `Invalid providerOptions for '${provider}'`,
    );
  });

  test("all schemas reject non-JSON values", () => {
    const unsafe = { permission: { bash: () => true } };
    expect(z.json().safeParse(unsafe).success).toBe(false);
    expect(OpenCodeProviderOptionsSchema.safeParse(unsafe).success).toBe(false);
  });
});

describe("exact MCP preapproval mappings", () => {
  test("unsupported providers do not negotiate exact tool policy", async () => {
    const registry = buildProviderRegistry(createTestLogger(), { isDev: true });
    const connection = await registry.mock.registration.connect({
      versions: [1],
      capabilities: ["permission.tool_policy"],
    });
    expect(connection.capabilities).toEqual([]);
    await expect(
      connection.send({
        type: "session.open",
        requestId: "policy-refused",
        sessionId: "policy-refused",
        config: {
          cwd: "/tmp",
          env: {},
          mcpServers: { hub: { type: "http", url: "http://127.0.0.1/hub" } },
          settings: {},
          toolPolicy: hubPolicy,
          persist: false,
        },
        history: "skip",
      }),
    ).rejects.toThrow("permission.tool_policy");
    await connection.close();
  });

  test("Codex enables and approves only the granted server tool", () => {
    expect(
      applyCodexToolPolicy(
        {
          mcp_servers: {
            hub: { url: "http://127.0.0.1/hub" },
            unrelated: { url: "http://127.0.0.1/unrelated" },
          },
        },
        hubPolicy,
      ),
    ).toEqual({
      mcp_servers: {
        hub: {
          url: "http://127.0.0.1/hub",
          enabled_tools: ["finish_execution"],
          default_tools_approval_mode: "prompt",
          tools: { finish_execution: { approval_mode: "approve" } },
        },
        unrelated: { url: "http://127.0.0.1/unrelated" },
      },
    });
  });

  test("Claude adds the exact MCP identity without replacing deny rules", () => {
    expect(
      applyClaudeToolPolicy(
        { allowedTools: ["Read"], disallowedTools: ["Bash", "mcp__hub__reply"] },
        hubPolicy,
      ),
    ).toEqual({
      allowedTools: ["Read", "mcp__hub__finish_execution"],
      disallowedTools: ["Bash", "mcp__hub__reply"],
    });
  });

  test("OpenCode applies exact internal grants after authored ask or deny rules", () => {
    expect(
      buildOpenCodePermissionRules(
        {
          permission: {
            hub_finish_execution: "deny",
            bash: "ask",
          },
        },
        hubPolicy,
      ),
    ).toEqual([
      { permission: "hub_finish_execution", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "hub_finish_execution", pattern: "*", action: "allow" },
    ]);
  });
});
