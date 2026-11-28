import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  createAgentToolGroupPatch,
  createAgentToolsMasterPatch,
  createOnboardingAgentToolsPatch,
  DEFAULT_AGENT_TOOL_GROUPS,
  isHostAgentToolsEnabled,
  resolveAgentToolsState,
} from "./agent-tools-config";

function makeConfig(overrides: Partial<MutableDaemonConfig> = {}): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    ...overrides,
  };
}

describe("agent tools UI state and legacy daemon compatibility", () => {
  it("reads unified daemon.tools state from a modern daemon", () => {
    const state = resolveAgentToolsState({
      config: makeConfig({
        tools: {
          enabled: true,
          groups: {
            orchestration: true,
            schedules: false,
            changeRequests: true,
            browser: true,
          },
        },
        mcp: { injectIntoAgents: true },
        browserTools: { enabled: true },
      }),
      supportsToolsConfig: true,
    });

    expect(state).toEqual({
      enabled: true,
      groups: {
        orchestration: true,
        schedules: false,
        changeRequests: true,
        browser: true,
      },
      supportsGroupControls: true,
    });
  });

  it("preserves saved group values when master enabled is false", () => {
    const state = resolveAgentToolsState({
      config: makeConfig({
        tools: {
          enabled: false,
          groups: {
            orchestration: false,
            schedules: true,
            changeRequests: false,
            browser: true,
          },
        },
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: true },
      }),
      supportsToolsConfig: true,
    });

    expect(state.enabled).toBe(false);
    expect(state.groups).toEqual({
      orchestration: false,
      schedules: true,
      changeRequests: false,
      browser: true,
    });
  });

  it("falls back cleanly to legacy mcp.injectIntoAgents and browserTools.enabled on older daemons", () => {
    const state = resolveAgentToolsState({
      config: makeConfig({
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: true },
      }),
      supportsToolsConfig: false,
    });

    expect(state).toEqual({
      enabled: false,
      groups: {
        ...DEFAULT_AGENT_TOOL_GROUPS,
        browser: true,
      },
      supportsGroupControls: false,
    });
  });

  it("builds tools.* patches for modern daemons and legacy mcp/browserTools patches for older daemons", () => {
    expect(createAgentToolsMasterPatch({ enabled: false, supportsToolsConfig: true })).toEqual({
      tools: { enabled: false },
    });
    expect(createAgentToolsMasterPatch({ enabled: false, supportsToolsConfig: false })).toEqual({
      mcp: { injectIntoAgents: false },
    });

    expect(
      createAgentToolGroupPatch({
        group: "schedules",
        enabled: false,
        supportsToolsConfig: true,
      }),
    ).toEqual({
      tools: { groups: { schedules: false } },
    });
    expect(
      createAgentToolGroupPatch({
        group: "browser",
        enabled: true,
        supportsToolsConfig: false,
      }),
    ).toEqual({
      browserTools: { enabled: true },
    });
    expect(
      createAgentToolGroupPatch({
        group: "orchestration",
        enabled: false,
        supportsToolsConfig: false,
      }),
    ).toBeNull();
  });

  it("setup writes only the main switch, and only when it differs from the host", () => {
    expect(
      createOnboardingAgentToolsPatch({
        enabled: true,
        currentEnabled: true,
        supportsToolsConfig: true,
      }),
    ).toBeNull();

    expect(
      createOnboardingAgentToolsPatch({
        enabled: true,
        currentEnabled: false,
        supportsToolsConfig: true,
      }),
    ).toEqual({ tools: { enabled: true } });

    expect(
      createOnboardingAgentToolsPatch({
        enabled: true,
        currentEnabled: null,
        supportsToolsConfig: true,
      }),
    ).toEqual({ tools: { enabled: true } });

    expect(
      createOnboardingAgentToolsPatch({
        enabled: false,
        currentEnabled: true,
        supportsToolsConfig: false,
      }),
    ).toEqual({ mcp: { injectIntoAgents: false } });
  });

  it("reports whether host agent tools are enabled for Voice UI checks", () => {
    expect(isHostAgentToolsEnabled(null)).toBe(true);
    expect(isHostAgentToolsEnabled(makeConfig({ tools: { enabled: true } }))).toBe(true);
    expect(isHostAgentToolsEnabled(makeConfig({ tools: { enabled: false } }))).toBe(false);
    expect(isHostAgentToolsEnabled(makeConfig({ mcp: { injectIntoAgents: false } }))).toBe(false);
  });
});
