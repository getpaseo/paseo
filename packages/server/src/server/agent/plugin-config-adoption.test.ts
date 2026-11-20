import { expect, test } from "vitest";
import { PluginConfigAdoptionsSchema } from "@getpaseo/protocol/plugin-agent-config";
import {
  configFragmentDigest,
  inspectLegacyAgentConfig,
  PluginConfigAdoptionAuthority,
  projectAgentRequiredConfig,
  selectLegacyAdoptions,
} from "./plugin-config-adoption.js";

test("preview blocks a named MCP binding referenced by an unmarked required policy", () => {
  expect(
    inspectLegacyAgentConfig({
      pluginId: "notes",
      recipe: {
        version: 1,
        selectors: [
          { id: "endpoint", group: "notes", label: "Notes tools", kind: "mcp", name: "notes" },
          {
            id: "read",
            group: "notes",
            label: "Notes read",
            kind: "grant",
            server: "notes",
            tool: "read",
          },
        ],
      },
      config: {
        provider: "claude",
        cwd: "/project",
        mcpServers: { notes: { type: "http", url: "http://127.0.0.1:1/?secret=dummy" } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
      },
      env: {},
    }).candidates,
  ).toContainEqual(
    expect.objectContaining({
      id: "endpoint",
      blockedReason: "Required or unmarked tool policy still references this server",
    }),
  );
});

test("projection removes exact adopted UTF-8 prompt bytes without mutating original caller intent", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    systemPrompt: "Caller α\n<notes>saved</notes>\nTail",
  };
  const receipt = {
    id: "receipt",
    pluginId: "notes",
    recipeDigest: "recipe",
    selectorId: "prompt",
    fragmentDigest: configFragmentDigest("<notes>saved</notes>"),
    fragment: {
      kind: "prompt" as const,
      start: 10,
      end: 30,
      promptDigest: configFragmentDigest(config.systemPrompt),
    },
  };
  expect(
    projectAgentRequiredConfig({ config, env: {}, receipts: { version: 1, receipts: [receipt] } })
      .config.systemPrompt,
  ).toBe("Caller α\n\nTail");
  expect(config.systemPrompt).toBe("Caller α\n<notes>saved</notes>\nTail");
  expect(() =>
    projectAgentRequiredConfig({
      config: { ...config, systemPrompt: "Caller changed\n<notes>saved</notes>\nTail" },
      env: {},
      receipts: { version: 1, receipts: [receipt] },
    }),
  ).toThrow(
    "Adopted plugin configuration is stale; reset the affected selection before editing it",
  );
});

test("adopting the final plugin-only grant removes the exhausted required policy from the projection", () => {
  const config = {
    provider: "opencode",
    cwd: "/project",
    toolPolicySource: "plugin" as const,
    providerOptions: { auto_accept: true },
    mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/notes" } },
    toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "read" }] },
  };
  const original = structuredClone(config);
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    config,
    env: {},
    recipe: {
      version: 1,
      selectors: [
        { id: "endpoint", group: "notes", label: "Notes", kind: "mcp", name: "notes" },
        {
          id: "read",
          group: "notes",
          label: "Read notes",
          kind: "grant",
          server: "notes",
          tool: "read",
        },
      ],
    },
    selections: [{ id: "endpoint" }, { id: "read" }],
  });
  const projected = projectAgentRequiredConfig({
    config,
    env: {},
    receipts: { version: 1, receipts },
  });
  expect(projected.config).not.toHaveProperty("toolPolicy");
  expect(projected.config).not.toHaveProperty("toolPolicySource");
  expect(projected.config.providerOptions).toEqual({ auto_accept: true });
  expect(projected.config.mcpServers).toEqual({});
  expect(config).toEqual(original);
});

test("projection preserves caller-required empty policies and unconsumed plugin grants", () => {
  const required = projectAgentRequiredConfig({
    config: { provider: "opencode", cwd: "/project", toolPolicy: { preapproved: [] } },
    env: {},
  });
  expect(required.config.toolPolicy).toEqual({ preapproved: [] });
  const config = {
    provider: "opencode",
    cwd: "/project",
    toolPolicySource: "plugin" as const,
    toolPolicy: {
      preapproved: [
        { kind: "mcp" as const, server: "notes", tool: "read" },
        { kind: "mcp" as const, server: "notes", tool: "write" },
      ],
    },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    config,
    env: {},
    recipe: {
      version: 1,
      selectors: [
        {
          id: "read",
          group: "notes",
          label: "Read notes",
          kind: "grant",
          server: "notes",
          tool: "read",
        },
      ],
    },
    selections: [{ id: "read" }],
  });
  expect(
    projectAgentRequiredConfig({ config, env: {}, receipts: { version: 1, receipts } }).config,
  ).toMatchObject({
    toolPolicySource: "plugin",
    toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "write" }] },
  });
});

test("option adoption requires an explicit baseline and never exposes its saved value", () => {
  const input = {
    pluginId: "computer",
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "timeout",
          group: "tools",
          label: "Tool timeout",
          kind: "option" as const,
          key: "timeout",
          baselines: [{ id: "inherit", label: "Inherit defaults", kind: "absent" as const }],
        },
      ],
    },
    config: { provider: "claude", cwd: "/project", providerOptions: { timeout: "dummy-secret" } },
    env: {},
  };
  expect(JSON.stringify(inspectLegacyAgentConfig(input).candidates)).not.toContain("dummy-secret");
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "timeout" }] })).toThrow(
    "Select an explicit baseline for timeout",
  );
  const receipts = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "timeout", baselineId: "inherit" }],
  });
  expect(
    projectAgentRequiredConfig({
      config: input.config,
      env: {},
      receipts: { version: 1, receipts },
    }).config.providerOptions,
  ).toEqual({});
  expect(input.config.providerOptions).toEqual({ timeout: "dummy-secret" });
});

test("adoption previews become stale after apply and reset restores unchanged original intent", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/?dummy-secret" } },
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
      ],
    },
  };
  const preview = authority.preview({ ...input, operation: "adopt" });
  expect(JSON.stringify(preview)).not.toContain("dummy-secret");
  const receipts = authority.apply({
    ...input,
    expectedFingerprint: preview.expectedFingerprint,
    selections: [{ id: "endpoint" }],
  });
  expect(projectAgentRequiredConfig({ ...input, receipts }).config.mcpServers).toEqual({});
  expect(() =>
    authority.apply({
      ...input,
      receipts,
      expectedFingerprint: preview.expectedFingerprint,
      selections: [{ id: "endpoint" }],
    }),
  ).toThrow("Legacy configuration preview is stale; preview again");
  const reset = authority.preview({ ...input, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    receipts,
    expectedFingerprint: reset.expectedFingerprint,
    receiptIds: [receipts.receipts[0]!.id],
  });
  expect(projectAgentRequiredConfig({ ...input, receipts: after }).config).toEqual(input.config);
  expect(() =>
    new PluginConfigAdoptionAuthority().apply({
      ...input,
      expectedFingerprint: preview.expectedFingerprint,
      selections: [{ id: "endpoint" }],
    }),
  ).toThrow("Legacy configuration preview is stale; preview again");
});

test("an exact predecessor suffix adopts only task text before a known HTML suffix", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    systemPrompt: "Caller\n\nExact task guidance\n\nExact HTML guidance",
  };
  const recipe = {
    version: 1 as const,
    selectors: [
      {
        id: "tasks-before-html",
        group: "tasks",
        label: "Task guidance",
        kind: "prompt-suffix" as const,
        text: "Exact task guidance",
        followedBySuffix: ["\n\nExact HTML guidance"],
      },
    ],
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "morphise",
    recipe,
    config,
    env: {},
    selections: [{ id: "tasks-before-html" }],
  });
  expect(
    projectAgentRequiredConfig({ config, env: {}, receipts: { version: 1, receipts } }).config
      .systemPrompt,
  ).toBe("Caller\n\n\n\nExact HTML guidance");
  expect(
    inspectLegacyAgentConfig({
      pluginId: "morphise",
      recipe,
      config: { ...config, systemPrompt: config.systemPrompt + " changed" },
      env: {},
    }).candidates,
  ).toEqual([]);
});

test("preview blocks an endpoint with a plugin-only grant missing an exact recipe selector", () => {
  const input = {
    pluginId: "notes",
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant" as const,
          server: "notes",
          tool: "read",
        },
      ],
    },
    config: {
      provider: "claude",
      cwd: "/project",
      toolPolicySource: "plugin" as const,
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
      toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "write" }] },
    },
    env: {},
  };
  expect(inspectLegacyAgentConfig(input).candidates).toContainEqual(
    expect.objectContaining({
      id: "endpoint",
      blockedReason:
        "Saved tool policy contains a grant without an exact legacy selector for this server",
    }),
  );
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "endpoint" }] })).toThrow(
    "Saved tool policy contains a grant without an exact legacy selector for this server",
  );
});

test("projection rejects endpoint receipts when a required policy starts referencing the server", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    recipe: {
      version: 1,
      selectors: [
        { id: "endpoint", group: "notes", label: "Notes tools", kind: "mcp", name: "notes" },
      ],
    },
    config,
    env: {},
    selections: [{ id: "endpoint" }],
  });
  expect(() =>
    projectAgentRequiredConfig({
      config: {
        ...config,
        toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
      },
      env: {},
      receipts: { version: 1, receipts },
    }),
  ).toThrow("Required tool policy cannot be projected by a plugin receipt");
});

test("projection rejects an endpoint receipt when its exact plugin-only grant has no matching receipt", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    toolPolicySource: "plugin" as const,
    mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    recipe: {
      version: 1,
      selectors: [
        { id: "endpoint", group: "notes", label: "Notes tools", kind: "mcp", name: "notes" },
      ],
    },
    config,
    env: {},
    selections: [{ id: "endpoint" }],
  });
  expect(() =>
    projectAgentRequiredConfig({
      config: {
        ...config,
        toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
      },
      env: {},
      receipts: { version: 1, receipts },
    }),
  ).toThrow("Adopt every exact plugin-only grant referencing the selected MCP server together");
});

test("projection rejects prompt receipt offsets inside a UTF-8 character", () => {
  const config = { provider: "claude", cwd: "/project", systemPrompt: "αx" };
  const receipt = {
    id: "receipt",
    pluginId: "notes",
    recipeDigest: "recipe",
    selectorId: "prompt",
    fragmentDigest: configFragmentDigest("�"),
    fragment: {
      kind: "prompt" as const,
      start: 1,
      end: 2,
      promptDigest: configFragmentDigest(config.systemPrompt),
    },
  };
  expect(() =>
    projectAgentRequiredConfig({ config, env: {}, receipts: { version: 1, receipts: [receipt] } }),
  ).toThrow("Adopted prompt ranges must use exact UTF-8 character boundaries");
  expect(config.systemPrompt).toBe("αx");
});

test("adoption preview fingerprints ignore unrelated saved titles", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      title: "Before",
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
      ],
    },
  };
  const preview = authority.preview({ ...input, operation: "adopt" });
  const receipts = authority.apply({
    ...input,
    config: { ...input.config, title: "After" },
    expectedFingerprint: preview.expectedFingerprint,
    selections: [{ id: "endpoint" }],
  });
  expect(
    projectAgentRequiredConfig({ ...input, config: { ...input.config, title: "After" }, receipts })
      .config,
  ).toEqual({ provider: "claude", cwd: "/project", title: "After", mcpServers: {} });
});

test("preview omits saved credentials, prompts, environment, and baseline values", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const preview = authority.preview({
    agentId: "agent",
    pluginId: "notes",
    operation: "adopt",
    config: {
      provider: "claude",
      cwd: "/project",
      systemPrompt: "Caller\n<notes>dummy-prompt-secret</notes>",
      providerOptions: { timeout: "dummy-option-secret" },
      mcpServers: {
        notes: {
          type: "http",
          url: "http://127.0.0.1:1/?dummy-url-secret",
          headers: { Authorization: "dummy-header-secret" },
        },
      },
    },
    env: { NOTES_TOKEN: "dummy-env-secret" },
    recipe: {
      version: 1,
      selectors: [
        { id: "endpoint", group: "notes", label: "Notes tools", kind: "mcp", name: "notes" },
        {
          id: "prompt",
          group: "notes",
          label: "Notes instructions",
          kind: "prompt-section",
          start: "<notes>",
          end: "</notes>",
        },
        {
          id: "timeout",
          group: "notes",
          label: "Timeout",
          kind: "option",
          key: "timeout",
          baselines: [
            { id: "known", label: "Known baseline", kind: "value", value: "dummy-baseline-secret" },
          ],
        },
        {
          id: "token",
          group: "notes",
          label: "Token",
          kind: "env",
          key: "NOTES_TOKEN",
          baselines: [{ id: "inherit", label: "Inherit defaults", kind: "absent" }],
        },
      ],
    },
  });
  expect(preview.candidates.map((candidate) => candidate.id)).toEqual([
    "endpoint",
    "prompt",
    "timeout",
    "token",
  ]);
  expect(JSON.stringify(preview)).not.toContain("-secret");
  expect(preview.candidates[2]!.baselines).toEqual([{ id: "known", label: "Known baseline" }]);
});

test("plugin-only endpoint adoption requires every exact grant and preserves unrelated bindings", () => {
  const input = {
    pluginId: "notes",
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant" as const,
          server: "notes",
          tool: "read",
        },
      ],
    },
    config: {
      provider: "claude",
      cwd: "/project",
      toolPolicySource: "plugin" as const,
      mcpServers: {
        notes: { type: "http" as const, url: "http://127.0.0.1:1/" },
        caller: { type: "http" as const, url: "http://127.0.0.1:2/" },
      },
      toolPolicy: {
        preapproved: [
          { kind: "mcp" as const, server: "notes", tool: "read" },
          { kind: "mcp" as const, server: "caller", tool: "keep" },
        ],
      },
    },
    env: {},
  };
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "endpoint" }] })).toThrow(
    "Adopt every exact plugin-only grant referencing the selected MCP server together",
  );
  const receipts = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "read" }, { id: "endpoint" }],
  });
  const projected = projectAgentRequiredConfig({ ...input, receipts: { version: 1, receipts } });
  expect(projected.config.mcpServers).toEqual({
    caller: { type: "http", url: "http://127.0.0.1:2/" },
  });
  expect(projected.config.toolPolicy).toEqual({
    preapproved: [{ kind: "mcp", server: "caller", tool: "keep" }],
  });
  expect(input.config.toolPolicy.preapproved).toEqual([
    { kind: "mcp", server: "notes", tool: "read" },
    { kind: "mcp", server: "caller", tool: "keep" },
  ]);
});

test("mixed unmarked policies block both endpoint and exact grant adoption", () => {
  const input = {
    pluginId: "notes",
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant" as const,
          server: "notes",
          tool: "read",
        },
      ],
    },
    config: {
      provider: "claude",
      cwd: "/project",
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
      toolPolicy: {
        preapproved: [
          { kind: "mcp" as const, server: "notes", tool: "read" },
          { kind: "mcp" as const, server: "caller", tool: "required" },
        ],
      },
    },
    env: {},
  };
  expect(inspectLegacyAgentConfig(input).candidates).toEqual([
    expect.objectContaining({
      id: "endpoint",
      blockedReason: "Required or unmarked tool policy still references this server",
    }),
    expect.objectContaining({
      id: "read",
      blockedReason: "Required or unmarked tool policy cannot be adopted",
    }),
  ]);
  expect(() =>
    selectLegacyAdoptions({ ...input, selections: [{ id: "endpoint" }, { id: "read" }] }),
  ).toThrow("Required or unmarked tool policy still references this server");
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "read" }] })).toThrow(
    "Required or unmarked tool policy cannot be adopted",
  );
});

test("projection rejects an adopted grant after policy provenance becomes unmarked", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    toolPolicySource: "plugin" as const,
    toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "read" }] },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    config,
    env: {},
    recipe: {
      version: 1,
      selectors: [
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant",
          server: "notes",
          tool: "read",
        },
      ],
    },
    selections: [{ id: "read" }],
  });
  expect(() =>
    projectAgentRequiredConfig({
      config: { ...config, toolPolicySource: undefined },
      env: {},
      receipts: { version: 1, receipts },
    }),
  ).toThrow("Required tool policy cannot be projected by a plugin receipt");
});

test("endpoint projection cannot borrow another plugin's grant receipt", () => {
  const input = {
    pluginId: "notes",
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant" as const,
          server: "notes",
          tool: "read",
        },
      ],
    },
    config: {
      provider: "claude",
      cwd: "/project",
      toolPolicySource: "plugin" as const,
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
      toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "read" }] },
    },
    env: {},
  };
  const receipts = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "endpoint" }, { id: "read" }],
  });
  expect(() =>
    projectAgentRequiredConfig({
      ...input,
      receipts: { version: 1, receipts: [receipts[0]!, { ...receipts[1]!, pluginId: "outsider" }] },
    }),
  ).toThrow("Adopt every exact plugin-only grant referencing the selected MCP server together");
});

test("projection rejects a receipt after the saved endpoint changes", () => {
  const config = {
    provider: "claude",
    cwd: "/project",
    mcpServers: {
      notes: { type: "http" as const, url: "http://127.0.0.1:1/?dummy-original-secret" },
    },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    config,
    env: {},
    recipe: {
      version: 1,
      selectors: [
        { id: "endpoint", group: "notes", label: "Notes tools", kind: "mcp", name: "notes" },
      ],
    },
    selections: [{ id: "endpoint" }],
  });
  expect(() =>
    projectAgentRequiredConfig({
      config: {
        ...config,
        mcpServers: { notes: { type: "http", url: "http://127.0.0.1:2/?dummy-new-secret" } },
      },
      env: {},
      receipts: { version: 1, receipts },
    }),
  ).toThrow(
    "Adopted plugin configuration is stale; reset the affected selection before editing it",
  );
});

test("environment adoption requires an explicit string baseline and preserves original values", () => {
  const input = {
    pluginId: "notes",
    config: { provider: "claude", cwd: "/project" },
    env: { NOTES_TOKEN: "dummy-saved-secret", CALLER: "keep" },
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "token",
          group: "notes",
          label: "Token",
          kind: "env" as const,
          key: "NOTES_TOKEN",
          baselines: [
            { id: "explicit", label: "Explicit value", kind: "value" as const, value: "baseline" },
            { id: "invalid", label: "Non-string value", kind: "value" as const, value: 0 },
          ],
        },
      ],
    },
  };
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "token" }] })).toThrow(
    "Select an explicit baseline for token",
  );
  expect(() =>
    selectLegacyAdoptions({ ...input, selections: [{ id: "token", baselineId: "invalid" }] }),
  ).toThrow("Environment baseline must be a string");
  const receipts = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "token", baselineId: "explicit" }],
  });
  expect(projectAgentRequiredConfig({ ...input, receipts: { version: 1, receipts } }).env).toEqual({
    NOTES_TOKEN: "baseline",
    CALLER: "keep",
  });
  expect(input.env).toEqual({ NOTES_TOKEN: "dummy-saved-secret", CALLER: "keep" });
});

test("ambiguous nested prompt sections stay blocked and unchanged", () => {
  const input = {
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      systemPrompt: "Caller<notes>outer<notes>inner</notes></notes>",
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "prompt",
          group: "notes",
          label: "Notes guidance",
          kind: "prompt-section" as const,
          start: "<notes>",
          end: "</notes>",
        },
      ],
    },
  };
  const inspection = inspectLegacyAgentConfig(input);
  expect(inspection.state).toEqual({ selectors: { prompt: "ambiguous" } });
  expect(inspection.candidates).toEqual([
    expect.objectContaining({ id: "prompt", blockedReason: "Saved prompt selector is ambiguous" }),
  ]);
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "prompt" }] })).toThrow(
    "Legacy configuration candidate is unavailable: prompt",
  );
  expect(input.config.systemPrompt).toBe("Caller<notes>outer<notes>inner</notes></notes>");
});

test("overlapping prompt candidates are blocked before adoption", () => {
  const input = {
    pluginId: "notes",
    config: { provider: "claude", cwd: "/project", systemPrompt: "Caller<notes>saved</notes>" },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "section",
          group: "notes",
          label: "Notes section",
          kind: "prompt-section" as const,
          start: "<notes>",
          end: "</notes>",
        },
        {
          id: "suffix",
          group: "notes",
          label: "Notes suffix",
          kind: "prompt-suffix" as const,
          text: "saved</notes>",
        },
      ],
    },
  };
  expect(inspectLegacyAgentConfig(input).candidates).toEqual([
    expect.objectContaining({ id: "section", blockedReason: "Saved prompt selections overlap" }),
    expect.objectContaining({ id: "suffix", blockedReason: "Saved prompt selections overlap" }),
  ]);
  expect(() => selectLegacyAdoptions({ ...input, selections: [{ id: "section" }] })).toThrow(
    "Saved prompt selections overlap",
  );
});

test("projection removes disjoint original UTF-8 ranges in descending order without trimming", () => {
  const input = {
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      systemPrompt: "α<notes>β</notes>\n Tail γ suffix",
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "section",
          group: "notes",
          label: "Notes section",
          kind: "prompt-section" as const,
          start: "<notes>",
          end: "</notes>",
        },
        {
          id: "suffix",
          group: "notes",
          label: "Notes suffix",
          kind: "prompt-suffix" as const,
          text: "γ suffix",
        },
      ],
    },
  };
  const receipts = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "section" }, { id: "suffix" }],
  });
  expect(receipts.map((receipt) => receipt.fragment)).toEqual([
    expect.objectContaining({ kind: "prompt", start: 2, end: 19 }),
    expect.objectContaining({ kind: "prompt", start: 26, end: 35 }),
  ]);
  expect(
    projectAgentRequiredConfig({ ...input, receipts: { version: 1, receipts } }).config
      .systemPrompt,
  ).toBe("α\n Tail ");
  expect(input.config.systemPrompt).toBe("α<notes>β</notes>\n Tail γ suffix");
});

test("projection rejects overlapping prompt receipts even when both fragment digests match", () => {
  const config = { provider: "claude", cwd: "/project", systemPrompt: "abcdef" };
  const receipts = [
    {
      id: "first",
      pluginId: "notes",
      recipeDigest: "recipe",
      selectorId: "first",
      fragmentDigest: configFragmentDigest("bcd"),
      fragment: {
        kind: "prompt" as const,
        start: 1,
        end: 4,
        promptDigest: configFragmentDigest(config.systemPrompt),
      },
    },
    {
      id: "second",
      pluginId: "notes",
      recipeDigest: "recipe",
      selectorId: "second",
      fragmentDigest: configFragmentDigest("def"),
      fragment: {
        kind: "prompt" as const,
        start: 3,
        end: 6,
        promptDigest: configFragmentDigest(config.systemPrompt),
      },
    },
  ];
  expect(() =>
    projectAgentRequiredConfig({ config, env: {}, receipts: { version: 1, receipts } }),
  ).toThrow("Adopted prompt ranges overlap or exceed the original prompt");
  expect(config.systemPrompt).toBe("abcdef");
});

test("apply rejects a preview after its literal recipe changes", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: { provider: "claude", cwd: "/project", systemPrompt: "Caller\nNotes guidance" },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "prompt",
          group: "notes",
          label: "Notes instructions",
          kind: "prompt-suffix" as const,
          text: "Notes guidance",
        },
      ],
    },
  };
  const preview = authority.preview({ ...input, operation: "adopt" });
  expect(() =>
    authority.apply({
      ...input,
      recipe: {
        version: 1,
        selectors: [
          {
            id: "prompt",
            group: "notes",
            label: "Notes instructions",
            kind: "prompt-suffix",
            text: "\nNotes guidance",
          },
        ],
      },
      expectedFingerprint: preview.expectedFingerprint,
      selections: [{ id: "prompt" }],
    }),
  ).toThrow("Legacy configuration preview is stale; preview again");
});

test("reset cannot remove another plugin's receipt", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
      ],
    },
  };
  const preview = authority.preview({ ...input, operation: "adopt" });
  const receipts = authority.apply({
    ...input,
    expectedFingerprint: preview.expectedFingerprint,
    selections: [{ id: "endpoint" }],
  });
  const outsider = { ...input, pluginId: "outsider", receipts };
  const reset = authority.preview({ ...outsider, operation: "reset" });
  expect(reset.receiptIds).toEqual([]);
  expect(() =>
    authority.reset({
      ...outsider,
      expectedFingerprint: reset.expectedFingerprint,
      receiptIds: [receipts.receipts[0]!.id],
    }),
  ).toThrow("Select unique receipt IDs belonging to this plugin");
  expect(projectAgentRequiredConfig({ ...input, receipts }).config.mcpServers).toEqual({});
});

function adoptEndpointAndGrant() {
  const authority = new PluginConfigAdoptionAuthority();
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      toolPolicySource: "plugin" as const,
      mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:1/" } },
      toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "read" }] },
    },
    env: {},
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "endpoint",
          group: "notes",
          label: "Notes tools",
          kind: "mcp" as const,
          name: "notes",
        },
        {
          id: "read",
          group: "notes",
          label: "Notes read",
          kind: "grant" as const,
          server: "notes",
          tool: "read",
        },
      ],
    },
  };
  const preview = authority.preview({ ...input, operation: "adopt" });
  const receipts = authority.apply({
    ...input,
    expectedFingerprint: preview.expectedFingerprint,
    selections: [{ id: "endpoint" }, { id: "read" }],
  });
  return { authority, input, receipts };
}

test("reset rejects removing a grant while its dependent endpoint remains adopted", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const original = structuredClone({ ...input, receipts });
  const preview = authority.preview({ ...input, receipts, operation: "reset" });
  expect(() =>
    authority.reset({
      ...input,
      receipts,
      expectedFingerprint: preview.expectedFingerprint,
      receiptIds: [receipts.receipts[1]!.id],
    }),
  ).toThrow(`Reset the dependent MCP endpoint receipt(s) together: ${receipts.receipts[0]!.id}`);
  expect({ ...input, receipts }).toEqual(original);
  expect(projectAgentRequiredConfig({ ...input, receipts }).config.mcpServers).toEqual({});
});

test("reset restores a complete endpoint and grant selection even when both fragments are stale", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const config = {
    ...input.config,
    mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:2/" } },
    toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "write" }] },
  };
  const original = structuredClone({ config, receipts });
  const preview = authority.preview({ ...input, config, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    config,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [receipts.receipts[0]!.id, receipts.receipts[1]!.id],
  });
  expect(after).toBeUndefined();
  expect(projectAgentRequiredConfig({ config, env: {}, receipts: after }).config).toEqual(config);
  expect({ config, receipts }).toEqual(original);
});

test("reset of only the endpoint preserves its original binding and keeps its grant adopted", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const original = structuredClone({ ...input, receipts });
  const preview = authority.preview({ ...input, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [receipts.receipts[0]!.id],
  });
  expect(after).toEqual({ version: 1, receipts: [receipts.receipts[1]!] });
  expect(projectAgentRequiredConfig({ ...input, receipts: after }).config).toEqual({
    provider: "claude",
    cwd: "/project",
    mcpServers: { notes: { type: "http", url: "http://127.0.0.1:1/" } },
  });
  expect({ ...input, receipts }).toEqual(original);
});

test("reset removes a stale endpoint receipt while preserving its valid grant receipt", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const config = {
    ...input.config,
    mcpServers: { notes: { type: "http" as const, url: "http://127.0.0.1:2/" } },
  };
  const preview = authority.preview({ ...input, config, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    config,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [receipts.receipts[0]!.id],
  });
  expect(after).toEqual({ version: 1, receipts: [receipts.receipts[1]!] });
  expect(projectAgentRequiredConfig({ config, env: {}, receipts: after }).config).toEqual({
    provider: "claude",
    cwd: "/project",
    mcpServers: { notes: { type: "http", url: "http://127.0.0.1:2/" } },
  });
});

test("reset removes a stale grant receipt when the current policy no longer references its endpoint", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const config = { ...input.config, toolPolicy: { preapproved: [] } };
  const preview = authority.preview({ ...input, config, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    config,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [receipts.receipts[1]!.id],
  });
  expect(after).toEqual({ version: 1, receipts: [receipts.receipts[0]!] });
  expect(projectAgentRequiredConfig({ config, env: {}, receipts: after }).config).toEqual({
    provider: "claude",
    cwd: "/project",
    toolPolicySource: "plugin",
    toolPolicy: { preapproved: [] },
    mcpServers: {},
  });
});

test("reset can recover selections one at a time while an unrelated fragment remains stale", () => {
  const { authority, input, receipts: pair } = adoptEndpointAndGrant();
  const receipts = PluginConfigAdoptionsSchema.parse({
    version: 1,
    receipts: [
      ...pair.receipts,
      {
        id: "token-receipt",
        pluginId: "notes",
        recipeDigest: "token-recipe",
        selectorId: "token",
        fragmentDigest: configFragmentDigest("dummy-saved"),
        fragment: {
          kind: "env",
          key: "NOTES_TOKEN",
          baseline: { id: "inherit", label: "Inherit", kind: "absent" },
        },
      },
    ],
  });
  const env = { NOTES_TOKEN: "dummy-changed" };
  const preview = authority.preview({ ...input, env, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    env,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [pair.receipts[0]!.id],
  });
  expect(after).toEqual({ version: 1, receipts: [pair.receipts[1]!, receipts.receipts[2]!] });
  expect(() => projectAgentRequiredConfig({ ...input, env, receipts: after })).toThrow(
    "Adopted plugin configuration is stale; reset the affected selection before editing it",
  );
  const recovery = authority.preview({ ...input, env, receipts: after, operation: "reset" });
  const recovered = authority.reset({
    ...input,
    env,
    receipts: after,
    expectedFingerprint: recovery.expectedFingerprint,
    receiptIds: ["token-receipt"],
  });
  expect(recovered).toEqual({ version: 1, receipts: [pair.receipts[1]!] });
  expect(projectAgentRequiredConfig({ ...input, env, receipts: recovered }).env).toEqual({
    NOTES_TOKEN: "dummy-changed",
  });
});

test("reset does not block recovery because an endpoint already lacks a different current grant", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const config = {
    ...input.config,
    toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "notes", tool: "write" }] },
  };
  const preview = authority.preview({ ...input, config, receipts, operation: "reset" });
  const after = authority.reset({
    ...input,
    config,
    receipts,
    expectedFingerprint: preview.expectedFingerprint,
    receiptIds: [receipts.receipts[1]!.id],
  });
  expect(after).toEqual({ version: 1, receipts: [receipts.receipts[0]!] });
  const recovery = authority.preview({ ...input, config, receipts: after, operation: "reset" });
  const recovered = authority.reset({
    ...input,
    config,
    receipts: after,
    expectedFingerprint: recovery.expectedFingerprint,
    receiptIds: [receipts.receipts[0]!.id],
  });
  expect(recovered).toBeUndefined();
  expect(projectAgentRequiredConfig({ config, env: {}, receipts: recovered }).config).toEqual(
    config,
  );
});

test.each([
  { owner: "another plugin", replacement: { pluginId: "outsider" } },
  { owner: "another recipe", replacement: { recipeDigest: "different-recipe" } },
])("reset cannot borrow a grant receipt from $owner", ({ replacement }) => {
  const { authority, input, receipts: pair } = adoptEndpointAndGrant();
  const receipts = {
    ...pair,
    receipts: [...pair.receipts, { ...pair.receipts[1]!, id: "other-grant", ...replacement }],
  };
  const original = structuredClone({ ...input, receipts });
  const preview = authority.preview({ ...input, receipts, operation: "reset" });
  expect(() =>
    authority.reset({
      ...input,
      receipts,
      expectedFingerprint: preview.expectedFingerprint,
      receiptIds: [pair.receipts[1]!.id],
    }),
  ).toThrow(`Reset the dependent MCP endpoint receipt(s) together: ${pair.receipts[0]!.id}`);
  expect({ ...input, receipts }).toEqual(original);
});

test("reset rejects a newly missing grant even when the endpoint already lacks another grant", () => {
  const { authority, input, receipts } = adoptEndpointAndGrant();
  const config = {
    ...input.config,
    toolPolicy: {
      preapproved: [
        { kind: "mcp" as const, server: "notes", tool: "read" },
        { kind: "mcp" as const, server: "notes", tool: "write" },
      ],
    },
  };
  const original = structuredClone({ config, receipts });
  const preview = authority.preview({ ...input, config, receipts, operation: "reset" });
  expect(() =>
    authority.reset({
      ...input,
      config,
      receipts,
      expectedFingerprint: preview.expectedFingerprint,
      receiptIds: [receipts.receipts[1]!.id],
    }),
  ).toThrow(`Reset the dependent MCP endpoint receipt(s) together: ${receipts.receipts[0]!.id}`);
  expect({ config, receipts }).toEqual(original);
});

test("apply rejects a 257th aggregate receipt without changing saved originals or receipts", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const existingReceipts = Array.from({ length: 256 }, (_, index) => ({
    id: `receipt-${index}`,
    pluginId: "previous",
    recipeDigest: "previous-recipe",
    selectorId: `option-${index}`,
    fragmentDigest: configFragmentDigest(true),
    fragment: {
      kind: "option" as const,
      key: `option-${index}`,
      baseline: { id: "inherit", label: "Inherit", kind: "absent" as const },
    },
  }));
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      providerOptions: {
        ...Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`option-${index}`, true])),
        added: "dummy-saved-value",
      },
    },
    env: {},
    receipts: PluginConfigAdoptionsSchema.parse({ version: 1, receipts: existingReceipts }),
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "added",
          group: "notes",
          label: "Added option",
          kind: "option" as const,
          key: "added",
          baselines: [{ id: "inherit", label: "Inherit", kind: "absent" as const }],
        },
      ],
    },
  };
  const original = structuredClone(input);
  const preview = authority.preview({ ...input, operation: "adopt" });
  const selected = selectLegacyAdoptions({
    ...input,
    selections: [{ id: "added", baselineId: "inherit" }],
  });
  expect(Buffer.byteLength(JSON.stringify([...existingReceipts, ...selected]))).toBeLessThan(
    131072,
  );
  expect(() =>
    authority.apply({
      ...input,
      expectedFingerprint: preview.expectedFingerprint,
      selections: [{ id: "added", baselineId: "inherit" }],
    }),
  ).toThrow("Too big: expected array to have <=256 items");
  expect(input).toEqual(original);
});

test("apply accepts exactly 256 aggregate receipts that remain valid for storage", () => {
  const authority = new PluginConfigAdoptionAuthority();
  const existingReceipts = Array.from({ length: 255 }, (_, index) => ({
    id: `receipt-${index}`,
    pluginId: "previous",
    recipeDigest: "previous-recipe",
    selectorId: `option-${index}`,
    fragmentDigest: configFragmentDigest(true),
    fragment: {
      kind: "option" as const,
      key: `option-${index}`,
      baseline: { id: "inherit", label: "Inherit", kind: "absent" as const },
    },
  }));
  const input = {
    agentId: "agent",
    pluginId: "notes",
    config: {
      provider: "claude",
      cwd: "/project",
      providerOptions: {
        ...Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`option-${index}`, true])),
        added: "dummy-saved-value",
      },
    },
    env: {},
    receipts: PluginConfigAdoptionsSchema.parse({ version: 1, receipts: existingReceipts }),
    recipe: {
      version: 1 as const,
      selectors: [
        {
          id: "added",
          group: "notes",
          label: "Added option",
          kind: "option" as const,
          key: "added",
          baselines: [{ id: "inherit", label: "Inherit", kind: "absent" as const }],
        },
      ],
    },
  };
  const original = structuredClone(input);
  const preview = authority.preview({ ...input, operation: "adopt" });
  const adoptions = authority.apply({
    ...input,
    expectedFingerprint: preview.expectedFingerprint,
    selections: [{ id: "added", baselineId: "inherit" }],
  });
  expect(adoptions.receipts).toHaveLength(256);
  expect(PluginConfigAdoptionsSchema.parse(adoptions)).toEqual(adoptions);
  expect(
    projectAgentRequiredConfig({ ...input, receipts: adoptions }).config.providerOptions,
  ).toEqual({});
  expect(input).toEqual(original);
});
