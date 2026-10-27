import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonConfigStore, applyMutableProviderConfigToOverrides } from "./daemon-config-store.js";
import { loadConfig } from "./config.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { readSpeechSettings } from "./speech/speech-settings.js";
import type { PersistedConfig } from "./persisted-config.js";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

function reloadableConfig(
  persisted: PersistedConfig,
  options: { relayEnabledFallback?: boolean } = {},
): MutableDaemonConfig {
  const daemon = persisted.daemon ?? {};
  const relay = daemon.relay ?? {};
  const git = daemon.git ?? {};
  const agents = persisted.agents ?? {};
  return {
    relay: {
      enabled: relay.enabled ?? options.relayEnabledFallback ?? true,
    },
    mcp: { enabled: true, injectIntoAgents: false },
    browserTools: { enabled: daemon.browserTools?.enabled ?? false },
    providers: (agents.providers ?? {}) as MutableDaemonConfig["providers"],
    metadataGeneration: { providers: agents.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: daemon.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false,
    idleRuntimeCleanup: agents.idleRuntimeCleanup !== false,
    appendSystemPrompt: daemon.appendSystemPrompt ?? "",
    terminalProfiles: daemon.terminalProfiles,
    agentProfiles: daemon.agentProfiles,
    cors: { allowedOrigins: [] },
    trustedProxies: ["loopback"],
    git: {
      maxProcessesPerSecond: git.maxProcessesPerSecond ?? 64,
      maxProcessConcurrency: git.maxProcessConcurrency ?? 8,
    },
    app: { baseUrl: "https://app.paseo.sh" },
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins ?? {},
  };
}

describe("applyMutableProviderConfigToOverrides", () => {
  test("merges mutable provider fields onto provider overrides", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          gemini: {
            extends: "acp",
            label: "Gemini",
            command: ["gemini", "--acp"],
          },
        },
        {
          gemini: {
            enabled: false,
            description: "Gemini ACP",
            env: { GEMINI_AUTO_UPDATE: "0" },
          },
          claude: {
            additionalModels: [
              {
                id: "claude-custom",
                label: "claude-custom",
              },
            ],
          },
        },
      ),
    ).toEqual({
      gemini: {
        extends: "acp",
        label: "Gemini",
        description: "Gemini ACP",
        command: ["gemini", "--acp"],
        env: { GEMINI_AUTO_UPDATE: "0" },
        enabled: false,
      },
      claude: {
        additionalModels: [
          {
            id: "claude-custom",
            label: "claude-custom",
          },
        ],
      },
    });
  });
});

describe("DaemonConfigStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patch persists relay state and emits its field change", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const changes: unknown[] = [];
    store.onFieldChange("relay.enabled", (value) => changes.push(value));

    await store.patch({ relay: { enabled: true } });

    expect(changes).toEqual([true]);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(true);
  });

  test("patch persists the relay protected security requirement independently of relay enablement", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      // A launch override owns relay.enabled; the security requirement is still editable.
      { relayEnabledMutable: false },
    );
    const changes: unknown[] = [];
    store.onFieldChange("relay.requireProtectedSecurity", (value) => changes.push(value));

    await store.patch({ relay: { requireProtectedSecurity: true } });

    expect(changes).toEqual([true]);
    expect(store.get().relay).toEqual({ enabled: true, requireProtectedSecurity: true });
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.requireProtectedSecurity).toBe(true);
  });

  test("patch round-trips agent profiles through the strictly-parsed persisted config", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    await store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work",
          icon: "🎨",
          provider: "claude",
          model: "claude-opus-5",
          modeId: "plan",
          thinkingOptionId: "think-hard",
          featureValues: { webSearch: true },
          notes: "Use for components, layout and design tokens.",
        },
      ],
    });

    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toEqual([
      {
        id: "profile_ui",
        name: "UI work",
        icon: "🎨",
        provider: "claude",
        model: "claude-opus-5",
        modeId: "plan",
        thinkingOptionId: "think-hard",
        featureValues: { webSearch: true },
        notes: "Use for components, layout and design tokens.",
      },
    ]);
    expect(store.get().agentProfiles).toHaveLength(1);
  });

  test("patch replaces the whole agent profile list rather than merging entries", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      agentProfiles: [
        { id: "a", name: "Keep", provider: "claude" },
        { id: "b", name: "Drop", provider: "codex" },
      ],
    });

    await store.patch({ agentProfiles: [{ id: "a", name: "Keep", provider: "claude" }] });

    expect(store.get().agentProfiles).toEqual([{ id: "a", name: "Keep", provider: "claude" }]);
    expect(loadPersistedConfig(paseoHome).daemon?.agentProfiles).toHaveLength(1);
  });

  test("rolls back config when a field transition fails", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    store.onFieldChange("relay.enabled", (enabled) => {
      if (enabled === true) {
        throw new Error("Relay transport failed to start");
      }
    });

    await expect(store.patch({ relay: { enabled: true } })).rejects.toThrow(
      "Relay transport failed to start",
    );
    expect(store.get().relay?.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("rolls back live owners when a later transactional owner fails", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(paseoHome, {
      relay: { enabled: false },
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    let browserToolsEnabled = false;
    store.onApply((next, previous) => {
      browserToolsEnabled = next.browserTools.enabled;
      return () => {
        browserToolsEnabled = previous.browserTools.enabled;
      };
    });
    store.onApply(() => {
      throw new Error("Provider refresh failed");
    });

    await expect(store.patch({ browserTools: { enabled: true } })).rejects.toThrow(
      "Provider refresh failed",
    );
    expect(browserToolsEnabled).toBe(false);
    expect(store.get().browserTools.enabled).toBe(false);
    expect(loadPersistedConfig(paseoHome).daemon?.browserTools?.enabled).toBeUndefined();
  });

  test("rejects relay patches when a launch override owns the setting", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    await expect(store.patch({ relay: { enabled: true } })).rejects.toThrow(
      "Relay is controlled by a daemon launch override",
    );
  });

  test("unrelated patches do not persist a one-launch relay override", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const persisted = loadPersistedConfig(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        ...persisted,
        daemon: { ...persisted.daemon, relay: { enabled: false } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    await store.patch({ browserTools: { enabled: true } });

    expect(loadPersistedConfig(paseoHome).daemon?.relay?.enabled).toBe(false);
  });

  test("unrelated patches persist only requested file intent", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    const before = loadPersistedConfig(paseoHome);
    const store = new DaemonConfigStore(
      paseoHome,
      {
        relay: { enabled: true },
        mcp: { enabled: false, injectIntoAgents: false },
        hostnames: ["launch.example.test"],
        cors: { allowedOrigins: ["https://launch.example.test"] },
        trustedProxies: true,
        git: { maxProcessesPerSecond: 7, maxProcessConcurrency: 2 },
        app: { baseUrl: "https://launch.example.test" },
        catalogRefreshTimeoutMs: 9_000,
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      { relayEnabledMutable: false },
    );

    await store.patch({
      appendSystemPrompt: "Only this field",
      // Reload-only runtime state is accepted as unknown wire data for forward
      // compatibility but is not part of the patch capability.
      hostnames: ["attempted-patch.example.test"],
    } as Parameters<typeof store.patch>[0]);

    expect(store.get().hostnames).toEqual(["launch.example.test"]);
    expect(loadPersistedConfig(paseoHome)).toEqual({
      ...before,
      daemon: { ...before.daemon, appendSystemPrompt: "Only this field" },
    });
  });

  test("patch persists provider enabled flags into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const initial = loadPersistedConfig(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    // Reuse the validated serializer through the store path by seeding the file directly.
    // This keeps the test focused on the merge behavior.
    const seeded =
      JSON.stringify(
        {
          ...initial,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath, seeded);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      providers: {
        gemini: { enabled: false },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toEqual({
      extends: "acp",
      label: "Gemini",
      command: ["gemini", "--acp"],
      enabled: false,
    });
  });

  test("patch persists provider Paseo-tool policy without changing availability", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ agents: { providers: { claude: { enabled: false } } } }),
    );
    const store = new DaemonConfigStore(paseoHome, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: { claude: { enabled: false } },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });

    await store.patch({
      providers: {
        claude: {
          paseoTools: { enabled: true, disabledTools: ["list_agents"] },
        },
      },
    });
    await store.patch({
      providers: {
        claude: {
          paseoTools: { disabledTools: ["create_agent"] },
        },
      },
    });

    expect(store.get().providers.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
    expect(loadPersistedConfig(paseoHome).agents?.providers?.claude).toEqual({
      enabled: false,
      paseoTools: { enabled: true, disabledTools: ["create_agent"] },
    });
  });

  test("patch removes provider entries from config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    expect(next.providers.claude).toEqual({ enabled: false });
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.gemini).toBeUndefined();
    expect(persisted.agents?.providers?.claude).toEqual({ enabled: false });
  });

  test("patch removes the providers object when the last provider is deleted", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: { gemini: {} },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ removeProviders: ["gemini"] });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
  });

  test("patch removes deleted providers from metadata generation", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
            metadataGeneration: {
              providers: [
                { provider: "gemini", model: "flash" },
                { provider: "claude", model: "haiku" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: {
          providers: [
            { provider: "gemini", model: "flash" },
            { provider: "claude", model: "haiku" },
          ],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.metadataGeneration.providers).toEqual([{ provider: "claude", model: "haiku" }]);
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  test("patch persists provider removal when in-memory config is already clean", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
            metadataGeneration: {
              providers: [{ provider: "gemini", model: "flash" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = await store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers).toBeUndefined();
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists append system prompt into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists browser tools opt-in into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ browserTools: { enabled: true } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.browserTools).toEqual({ enabled: true });
  });

  test("patch persists provider additional models into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      providers: {
        claude: {
          additionalModels: [
            {
              id: "claude-custom",
              label: "claude-custom",
            },
          ],
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.claude).toEqual({
      additionalModels: [
        {
          id: "claude-custom",
          label: "claude-custom",
        },
      ],
    });
  });

  test("patch persists daemon append system prompt into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists enable terminal agent hooks into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({ enableTerminalAgentHooks: true });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.daemon?.enableTerminalAgentHooks).toBe(true);
  });

  test("patch persists metadata generation providers into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    await store.patch({
      metadataGeneration: {
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
        ],
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("patch persists clearing metadata generation providers into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            metadataGeneration: {
              providers: [{ provider: "claude", model: "haiku" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
      undefined,
    );

    await store.patch({ metadataGeneration: { providers: [] } });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists the host idle runtime cleanup opt-out for the next daemon start", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        agents: { metadataGeneration: { providers: [{ provider: "claude" }] } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        idleRuntimeCleanup: true,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude" }] },
      },
      undefined,
    );

    expect((await store.patch({ idleRuntimeCleanup: false })).idleRuntimeCleanup).toBe(false);

    expect(loadPersistedConfig(paseoHome).agents).toEqual({
      metadataGeneration: { providers: [{ provider: "claude" }] },
      idleRuntimeCleanup: false,
    });
    expect(loadConfig(paseoHome, { env: {} }).idleRuntimeCleanup).toBe(false);

    await store.patch({ idleRuntimeCleanup: true });
    expect(loadConfig(paseoHome, { env: {} }).idleRuntimeCleanup).toBe(true);
  });

  test("patch persists custom ACP provider overrides into config.json", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-store-"));
    tempDirs.push(paseoHome);

    const store = new DaemonConfigStore(
      paseoHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [] },
      },
      undefined,
    );

    await store.patch({
      providers: {
        "paseo-e2e-acp": {
          extends: "acp",
          label: "Paseo E2E ACP",
          description: "E2E ACP provider fixture",
          command: ["npx", "-y", "--version"],
          env: {},
        },
      },
    });

    const persisted = loadPersistedConfig(paseoHome);
    expect(persisted.agents?.providers?.["paseo-e2e-acp"]).toEqual({
      extends: "acp",
      label: "Paseo E2E ACP",
      description: "E2E ACP provider fixture",
      command: ["npx", "-y", "--version"],
      env: {},
    });
  });
});

describe("DaemonConfigStore reload", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createReloadableStore(
    options: {
      overrideControlledPaths?: string[];
      initialPersisted?: PersistedConfig;
    } = {},
  ) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-reload-"));
    tempDirs.push(paseoHome);
    if (options.initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(options.initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const relayEnabledFallback = persisted.daemon?.relay?.enabled === undefined;
    const initialMutable = reloadableConfig(persisted, { relayEnabledFallback });
    const store = new DaemonConfigStore(paseoHome, initialMutable, undefined, {
      reloadSource: {
        resolve: (nextPersisted) => {
          const mutable = reloadableConfig(nextPersisted, { relayEnabledFallback });
          if (options.overrideControlledPaths?.includes("daemon.relay.enabled")) {
            mutable.relay = initialMutable.relay;
          }
          return {
            mutable,
            overrideControlledPaths: options.overrideControlledPaths ?? [],
          };
        },
      },
    });
    return { paseoHome, store, persisted };
  }

  function writeConfig(paseoHome: string, config: unknown): void {
    writeFileSync(path.join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  test("applies overlapping plugin mutations to the latest committed sources", async () => {
    const { store } = createReloadableStore({
      initialPersisted: {
        plugins: {
          a: { source: "directory", path: "/a", enabled: false },
          b: { source: "directory", path: "/b", enabled: true },
        },
      },
    });
    const enable = store.patch((current) => ({
      plugins: {
        ...current.plugins,
        a: { ...current.plugins.a!, enabled: true },
      },
    }));
    const disable = store.patch((current) => ({
      plugins: {
        ...current.plugins,
        b: { ...current.plugins.b!, enabled: false },
      },
    }));
    await Promise.all([enable, disable]);
    expect(store.get().plugins).toEqual({
      a: { source: "directory", path: "/a", enabled: true },
      b: { source: "directory", path: "/b", enabled: false },
    });
  });

  test("serializes overlapping patches before committing their combined state", async () => {
    const { paseoHome, store } = createReloadableStore();
    const first = store.patch({ appendSystemPrompt: "first" });
    const second = store.patch({ browserTools: { enabled: true } });
    expect(store.get().appendSystemPrompt).toBe("");
    await Promise.all([first, second]);
    expect(store.get().appendSystemPrompt).toBe("first");
    expect(store.get().browserTools.enabled).toBe(true);
    expect(loadPersistedConfig(paseoHome).daemon).toMatchObject({
      appendSystemPrompt: "first",
      browserTools: { enabled: true },
    });
  });

  test("applies mutable edits and reports startup-only edits", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        browserTools: { enabled: true },
        git: { maxProcessesPerSecond: 12, maxProcessConcurrency: 3 },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [
        "daemon.browserTools.enabled",
        "daemon.git.maxProcessConcurrency",
        "daemon.git.maxProcessesPerSecond",
      ],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    });
    expect(store.get().browserTools.enabled).toBe(true);
    expect(store.get().git).toEqual({ maxProcessesPerSecond: 12, maxProcessConcurrency: 3 });
  });

  test("reloads idle runtime cleanup in both directions without requiring a restart", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    const changes: unknown[] = [];
    store.onFieldChange("idleRuntimeCleanup", (value) => changes.push(value));
    for (const enabled of [false, true]) {
      writeConfig(paseoHome, { ...persisted, agents: { idleRuntimeCleanup: enabled } });
      expect(await store.reload()).toEqual({
        appliedPaths: ["agents.idleRuntimeCleanup"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      });
      expect(store.get().idleRuntimeCleanup).toBe(enabled);
    }
    expect(changes).toEqual([false, true]);
    await store.patch({ idleRuntimeCleanup: false });
    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().idleRuntimeCleanup).toBe(false);
  });

  test("applies the global plugin switch in both directions", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      initialPersisted: { version: 1, pluginsEnabled: false },
    });
    const changes: unknown[] = [];
    store.onFieldChange("pluginsEnabled", (value) => changes.push(value));

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: true });
    expect(await store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(true);

    writeConfig(paseoHome, { ...persisted, pluginsEnabled: false });
    expect(await store.reload()).toEqual({
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect(store.get().pluginsEnabled).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("classifies every leaf when a parent subtree is added", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: {
          enabled: false,
          endpoint: "relay.example.test:443",
          useTls: true,
        },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: ["daemon.relay.enabled"],
      restartRequiredPaths: ["daemon.relay.endpoint", "daemon.relay.useTls"],
      overrideControlledPaths: [],
    });
  });

  test("classifies every leaf when the daemon subtree is removed", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: {
        version: 1,
        daemon: {
          listen: "127.0.0.1:7777",
          browserTools: { enabled: true },
          relay: {
            enabled: false,
            endpoint: "relay.example.test:443",
            useTls: true,
          },
          serviceProxy: {
            listen: "127.0.0.1:7788",
            publicBaseUrl: "https://services.example.test",
          },
        },
      },
    });
    writeConfig(paseoHome, { version: 1 });

    expect(await store.reload()).toEqual({
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: [
        "daemon.listen",
        "daemon.relay.endpoint",
        "daemon.relay.useTls",
        "daemon.serviceProxy.listen",
        "daemon.serviceProxy.publicBaseUrl",
      ],
      overrideControlledPaths: [],
    });
    expect(store.get().relay?.enabled).toBe(false);
  });

  test("keeps overridden leaves separate from restart-required siblings", async () => {
    const { paseoHome, store } = createReloadableStore({
      initialPersisted: { version: 1 },
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      version: 1,
      daemon: {
        relay: { enabled: false, endpoint: "relay.example.test:443" },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: ["daemon.relay.endpoint"],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("invalid JSON and invalid schema apply nothing", async () => {
    const { paseoHome, store } = createReloadableStore();
    writeFileSync(path.join(paseoHome, "config.json"), "{ nope\n");
    await expect(store.reload()).rejects.toThrow("Invalid JSON");
    expect(store.get().browserTools.enabled).toBe(false);

    writeConfig(paseoHome, { daemon: { browserTools: { enabled: "yes" } } });
    await expect(store.reload()).rejects.toThrow("Invalid config");
    expect(store.get().browserTools.enabled).toBe(false);
  });

  test("removing providers and optional profiles clears live state", async () => {
    const { paseoHome, store, persisted } = createReloadableStore();
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        terminalProfiles: [{ id: "shell", name: "Shell", command: "bash" }],
        agentProfiles: [{ id: "review", name: "Review", provider: "codex" }],
      },
      agents: {
        providers: {
          gemini: { extends: "acp", label: "Gemini", command: ["gemini", "--acp"] },
        },
      },
    });
    await store.reload();

    writeConfig(paseoHome, persisted);
    const result = await store.reload();

    expect(result.appliedPaths).toEqual([
      "agents.providers",
      "daemon.agentProfiles",
      "daemon.terminalProfiles",
    ]);
    expect(store.get().providers).toEqual({});
    expect(store.get().terminalProfiles).toBeUndefined();
    expect(store.get().agentProfiles).toBeUndefined();
  });

  test("reports a launch-controlled edit without changing live state", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    const initialRelay = store.get().relay?.enabled;
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: !initialRelay } },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    expect(store.get().relay?.enabled).toBe(initialRelay);
  });

  test("an unrelated patch does not mark a manual override-owned edit as applied", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: { ...persisted.daemon, relay: { enabled: true } },
    });
    await store.patch({ appendSystemPrompt: "patched elsewhere" });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.relay.enabled"],
    });
  });

  test("reports startup-only launch overrides instead of restart warnings", async () => {
    const { paseoHome, store, persisted } = createReloadableStore({
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
    writeConfig(paseoHome, {
      ...persisted,
      daemon: {
        ...persisted.daemon,
        listen: "127.0.0.1:7777",
        relay: {
          ...persisted.daemon?.relay,
          endpoint: "relay.example.test:443",
        },
      },
    });

    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: ["daemon.listen", "daemon.relay.endpoint"],
    });
  });

  test("a no-op reload returns empty path lists", async () => {
    const { store } = createReloadableStore();
    expect(await store.reload()).toEqual({
      appliedPaths: [],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
  });
});

describe("DaemonConfigStore speech settings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createSpeechStore(initialPersisted?: unknown, env: NodeJS.ProcessEnv = {}) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-daemon-config-speech-"));
    tempDirs.push(paseoHome);
    if (initialPersisted) {
      writeFileSync(
        path.join(paseoHome, "config.json"),
        `${JSON.stringify(initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(paseoHome);
    const applied: PersistedConfig[] = [];
    const speech = {
      read: (next: PersistedConfig) => readSpeechSettings(next, env),
      apply: (next: PersistedConfig) => applied.push(next),
    };
    const store = new DaemonConfigStore(paseoHome, reloadableConfig(persisted), undefined, {
      speech,
      reloadSource: {
        resolve: (next) => ({ mutable: reloadableConfig(next), overrideControlledPaths: [] }),
      },
    });
    return { paseoHome, store, applied, persisted };
  }

  test("reads, patches, and clears local STT language without losing it on other saves", async () => {
    const { paseoHome, store } = createSpeechStore({
      features: { dictation: { stt: { language: "fr" } } },
    });
    expect(store.get().features?.dictation.stt).toEqual({ provider: "local", language: "fr" });
    await store.patch({ features: { voiceMode: { enabled: true } } });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({
      provider: "local",
      language: "fr",
    });
    const patched = await store.patch({
      features: { dictation: { stt: { provider: "local", language: "de" } } },
    });
    expect(patched.features?.dictation.stt).toEqual({ provider: "local", language: "de" });
    await store.patch({ features: { dictation: { stt: { language: null } } } });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({ provider: "local" });
  });

  test("reports language env overrides for both local STT sites", async () => {
    const { store } = createSpeechStore(
      {},
      { PASEO_DICTATION_LANGUAGE: "fr", PASEO_VOICE_LANGUAGE: "de" },
    );
    expect(store.get().envOverrides).toMatchObject({
      "features.dictation.stt.language": "PASEO_DICTATION_LANGUAGE",
      "features.voiceMode.stt.language": "PASEO_VOICE_LANGUAGE",
    });
  });

  test("keeps voice mode off until it is turned on", async () => {
    const { paseoHome, store } = createSpeechStore();

    expect(store.get().features?.dictation.enabled).toBe(true);
    expect(store.get().features?.voiceMode.enabled).toBe(false);

    const result = await store.patch({ features: { voiceMode: { enabled: true } } });

    expect(result.features?.voiceMode.enabled).toBe(true);
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.enabled).toBe(true);
  });

  test("stores the OpenAI key without ever returning it", async () => {
    const { paseoHome, store, applied } = createSpeechStore();

    const result = await store.patch({
      features: { dictation: { stt: { provider: "openai", apiKey: " sk-test " } } },
    });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: true });
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toMatchObject({
      apiKey: "sk-test",
    });
    expect(applied).toHaveLength(1);
  });

  test("applies a replaced key even though the visible settings do not change", async () => {
    const { store, applied } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } },
    });

    await store.patch({ features: { dictation: { stt: { apiKey: "sk-new" } } } });

    expect(applied.map((next) => next.features?.dictation?.stt)).toEqual([
      { provider: "openai", apiKey: "sk-new" },
    ]);
  });

  test("switching provider clears the previous provider's model", async () => {
    const { paseoHome, store } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v3-int8" } } },
    });

    const result = await store.patch({ features: { dictation: { stt: { provider: "openai" } } } });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: false });
    expect(loadPersistedConfig(paseoHome).features?.dictation?.stt).toEqual({
      provider: "openai",
    });
  });

  test("rejects a local model id outside the catalog without persisting it", async () => {
    const { paseoHome, store, applied } = createSpeechStore();

    await expect(
      store.patch({ features: { voiceMode: { tts: { provider: "local", model: "nope" } } } }),
    ).rejects.toThrow("Unknown local voice model: nope");
    expect(loadPersistedConfig(paseoHome).features?.voiceMode).toBeUndefined();
    expect(applied).toEqual([]);
  });

  test("reload applies hand-edited speech settings without a restart", async () => {
    const { paseoHome, store, applied, persisted } = createSpeechStore();
    writeFileSync(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({ ...persisted, features: { voiceMode: { enabled: false } } }, null, 2)}\n`,
    );

    const result = await store.reload();

    expect(result.appliedPaths).toContain("features.voiceMode");
    expect(result.restartRequiredPaths).toEqual([]);
    expect(store.get().features?.voiceMode.enabled).toBe(false);
    expect(applied).toHaveLength(1);
  });
  test("merges same-provider fields and replaces the whole variant when provider changes", async () => {
    const { paseoHome, store } = createSpeechStore();
    await store.patch({
      features: {
        voiceMode: {
          stt: { provider: "openai", apiKey: "secret", baseUrl: "https://site/v1", model: "first" },
        },
      },
    });
    await store.patch({ features: { voiceMode: { stt: { model: "second", baseUrl: null } } } });
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "secret",
      model: "second",
    });
    await store.patch({ features: { voiceMode: { stt: { provider: "openai", model: "third" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "third",
      hasApiKey: true,
    });
    await store.patch({ features: { voiceMode: { stt: { apiKey: "new-secret" } } } });
    await store.patch({ features: { voiceMode: { stt: { provider: "local" } } } });
    await store.patch({ features: { voiceMode: { stt: { provider: "openai" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({ provider: "openai", hasApiKey: false });
  });

  test("keeps a saved OpenAI key when a full variant patch omits the write-only key", async () => {
    const { paseoHome, store } = createSpeechStore({
      features: { voiceMode: { stt: { provider: "openai", apiKey: "saved-secret" } } },
    });
    const result = await store.patch({
      features: { voiceMode: { stt: { provider: "openai", model: "whisper-1" } } },
    });
    expect(result.features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "whisper-1",
      hasApiKey: true,
    });
    expect(loadPersistedConfig(paseoHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "saved-secret",
      model: "whisper-1",
    });
    expect(JSON.stringify(result)).not.toContain("saved-secret");
  });

  test("loads a legacy host, redacts its key and writes the normalized config after any save", async () => {
    const { paseoHome, store } = createSpeechStore({
      providers: { openai: { apiKey: "legacy-secret", stt: { baseUrl: "https://old/v1" } } },
      features: { voiceMode: { enabled: true, stt: { provider: "openai" } } },
    });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      baseUrl: "https://old/v1",
      hasApiKey: true,
    });
    expect(JSON.stringify(store.get())).not.toContain("legacy-secret");
    await store.patch({ autoArchiveAfterMerge: true });
    const disk = JSON.parse(readFileSync(path.join(paseoHome, "config.json"), "utf8"));
    expect(disk.providers).not.toHaveProperty("openai");
    expect(disk.features.voiceMode.stt.apiKey).toBe("legacy-secret");
  });

  test("reports env overrides and removes fallback provenance after saving a key", async () => {
    const { store } = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai", model: "configured" } } } },
      {
        PASEO_VOICE_STT_PROVIDER: "local",
        OPENAI_API_KEY: "env-secret",
      },
    );
    expect(store.get().features?.voiceMode.stt.provider).toBe("local");
    expect(store.get().envOverrides).toEqual({
      "features.voiceMode.stt.provider": "PASEO_VOICE_STT_PROVIDER",
    });
    const other = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai" } } } },
      {
        OPENAI_API_KEY: "env-secret",
        OPENAI_STT_BASE_URL: "https://env/v1",
        STT_MODEL: "override",
      },
    ).store;
    expect(other.get().envOverrides).toEqual({
      "features.voiceMode.stt.apiKey": "OPENAI_API_KEY",
      "features.voiceMode.stt.baseUrl": "OPENAI_STT_BASE_URL",
      "features.voiceMode.stt.model": "STT_MODEL",
    });
    expect(other.get().features?.voiceMode.stt.hasApiKey).toBe(false);
    await other.patch({
      features: { voiceMode: { stt: { apiKey: "saved-secret", baseUrl: "https://saved/v1" } } },
    });
    expect(other.get().envOverrides).toEqual({ "features.voiceMode.stt.model": "STT_MODEL" });
    expect(JSON.stringify(other.get())).not.toContain("secret");
  });
});
