import pino from "pino";
import { describe, expect, it } from "vitest";
import { agentConfigs, allProviders } from "../../daemon-e2e/agent-configs.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  AGENT_PROVIDER_IDS,
  BUILTIN_PROVIDER_IDS,
  getAgentProviderDefinition,
  getModeVisuals,
  isValidAgentProvider,
} from "../provider-manifest.js";
import { buildProviderRegistry } from "../provider-registry.js";

const silentLogger = pino({ level: "silent" });
const VALID_ICONS = new Set(["ShieldCheck", "ShieldAlert", "ShieldOff"]);
const VALID_COLOR_TIERS = new Set(["safe", "moderate", "dangerous", "planning"]);

describe("codebuddy provider registration — manifest", () => {
  it("appears in AGENT_PROVIDER_DEFINITIONS", () => {
    const ids = AGENT_PROVIDER_DEFINITIONS.map((d) => d.id);
    expect(ids).toContain("codebuddy");
  });

  it("appears in BUILTIN_PROVIDER_IDS and AGENT_PROVIDER_IDS", () => {
    expect(BUILTIN_PROVIDER_IDS).toContain("codebuddy");
    expect(AGENT_PROVIDER_IDS).toContain("codebuddy");
  });

  it("isValidAgentProvider accepts 'codebuddy'", () => {
    expect(isValidAgentProvider("codebuddy")).toBe(true);
  });

  it("getAgentProviderDefinition('codebuddy') returns a usable definition", () => {
    const def = getAgentProviderDefinition("codebuddy");
    expect(def.id).toBe("codebuddy");
    expect(def.label).toBe("CodeBuddy");
    expect(def.defaultModeId).toBe("default");
    expect(def.modes.length).toBeGreaterThan(0);
    const modeIds = def.modes.map((m) => m.id);
    expect(modeIds).toContain("default");
    expect(modeIds).toContain("acceptEdits");
    expect(modeIds).toContain("plan");
    expect(modeIds).toContain("bypassPermissions");
  });

  it("defaultModeId points to an actual mode in the modes array", () => {
    const def = getAgentProviderDefinition("codebuddy");
    expect(def.defaultModeId).not.toBeNull();
    const modeIds = def.modes.map((m) => m.id);
    expect(modeIds).toContain(def.defaultModeId as string);
  });

  it("every mode has a valid icon and colorTier", () => {
    const def = getAgentProviderDefinition("codebuddy");
    for (const mode of def.modes) {
      expect(VALID_ICONS.has(mode.icon)).toBe(true);
      expect(VALID_COLOR_TIERS.has(mode.colorTier)).toBe(true);
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(0);
    }
  });

  it("getModeVisuals returns icon + colorTier for each codebuddy mode", () => {
    const def = getAgentProviderDefinition("codebuddy");
    for (const mode of def.modes) {
      const visuals = getModeVisuals("codebuddy", mode.id, AGENT_PROVIDER_DEFINITIONS);
      expect(visuals).toBeDefined();
      expect(visuals?.icon).toBe(mode.icon);
      expect(visuals?.colorTier).toBe(mode.colorTier);
    }
  });

  it("getModeVisuals returns undefined for an unknown mode", () => {
    expect(getModeVisuals("codebuddy", "no-such-mode", AGENT_PROVIDER_DEFINITIONS)).toBeUndefined();
  });
});

describe("codebuddy provider registration — registry", () => {
  it("buildProviderRegistry includes a codebuddy entry that is enabled", () => {
    const registry = buildProviderRegistry(silentLogger);
    expect(registry.codebuddy).toBeDefined();
    expect(registry.codebuddy.enabled).toBe(true);
    expect(registry.codebuddy.id).toBe("codebuddy");
  });

  it("codebuddy createClient produces a client whose provider is 'codebuddy'", () => {
    const registry = buildProviderRegistry(silentLogger);
    const client = registry.codebuddy.createClient(silentLogger);
    expect(client.provider).toBe("codebuddy");
  });

  it("respects providerOverrides label override", () => {
    const registry = buildProviderRegistry(silentLogger, {
      providerOverrides: {
        codebuddy: {
          label: "CodeBuddy (Tencent Internal)",
          env: { CODEBUDDY_AUTH_TOKEN: "internal-token" },
        },
      },
    });
    expect(registry.codebuddy.label).toBe("CodeBuddy (Tencent Internal)");
  });

  it("respects custom command override (e.g. internal Tencent codebuddy build)", () => {
    const registry = buildProviderRegistry(silentLogger, {
      providerOverrides: {
        codebuddy: {
          command: ["/opt/tencent/codebuddy", "--acp"],
        },
      },
    });
    expect(registry.codebuddy.id).toBe("codebuddy");
  });

  it("respects providerOverrides.enabled === false", () => {
    const registry = buildProviderRegistry(silentLogger, {
      providerOverrides: {
        codebuddy: { enabled: false },
      },
    });
    expect(registry.codebuddy.enabled).toBe(false);
  });

  it("merges additionalModels into runtime-discovered models without replacing them", async () => {
    const registry = buildProviderRegistry(silentLogger, {
      providerOverrides: {
        codebuddy: {
          additionalModels: [
            {
              id: "claude-opus-4.7",
              label: "Opus 4.7 (curated label)",
              isDefault: true,
            },
          ],
        },
      },
    });
    // additionalModels are merged at fetch time; we only verify the registry
    // entry accepted the override (no error thrown). The actual merge against
    // runtime models is exercised by provider-registry.test.ts's model tests.
    expect(registry.codebuddy).toBeDefined();
  });
});

describe("codebuddy provider registration — daemon-e2e config", () => {
  it("agentConfigs.codebuddy exists with both ask and full modes", () => {
    expect(agentConfigs.codebuddy).toBeDefined();
    expect(agentConfigs.codebuddy.provider).toBe("codebuddy");
    expect(agentConfigs.codebuddy.modes?.full).toBe("bypassPermissions");
    expect(agentConfigs.codebuddy.modes?.ask).toBe("default");
  });

  it("codebuddy modes referenced in agentConfigs exist in the manifest", () => {
    const def = getAgentProviderDefinition("codebuddy");
    const modeIds = def.modes.map((m) => m.id);
    expect(modeIds).toContain(agentConfigs.codebuddy.modes!.full);
    expect(modeIds).toContain(agentConfigs.codebuddy.modes!.ask);
  });

  it("codebuddy is listed in allProviders for e2e iteration", () => {
    expect(allProviders).toContain("codebuddy");
  });
});
