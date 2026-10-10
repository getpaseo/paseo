import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";
import {
  createBrowserToolsPatch,
  getBrowserToolsCardState,
  getBrowserToolsMutationViewState,
} from "./browser-tools-config";

function makeConfig(browserToolsEnabled = false): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: browserToolsEnabled },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

describe("browser tools opt-in config", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows the card with the logged-in browser state warning when connected", () => {
    expect(getBrowserToolsCardState({ isConnected: true, config: makeConfig(false) })).toEqual({
      isVisible: true,
      isEnabled: false,
      title: "Browser tools",
      warning: en.settings.host.browserTools.warning,
    });
  });

  it("reads enabled state from daemon config", () => {
    expect(getBrowserToolsCardState({ isConnected: true, config: makeConfig(true) })).toMatchObject(
      {
        isEnabled: true,
      },
    );
  });

  it("hides the card when the host is disconnected", () => {
    expect(
      getBrowserToolsCardState({ isConnected: false, config: makeConfig(true) }),
    ).toMatchObject({
      isVisible: false,
    });
  });

  it("writes daemon.browserTools.enabled when toggled", () => {
    expect(createBrowserToolsPatch(true)).toEqual({ browserTools: { enabled: true } });
    expect(createBrowserToolsPatch(false)).toEqual({ browserTools: { enabled: false } });
  });

  it("shows loading and disables the toggle while browser tool settings save", () => {
    expect(getBrowserToolsMutationViewState({ isPending: true, error: null })).toEqual({
      isSwitchDisabled: true,
      loadingText: "Updating browser tools…",
      errorText: null,
    });
  });

  it("shows the save error when browser tool settings fail", () => {
    expect(
      getBrowserToolsMutationViewState({ isPending: false, error: new Error("Disk full") }),
    ).toEqual({
      isSwitchDisabled: false,
      loadingText: null,
      errorText: "Disk full",
    });
  });

  it("shows the card and loading text in the app language", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(
      getBrowserToolsCardState({ isConnected: true, config: makeConfig(false) }),
    ).toMatchObject({
      title: zhCN.settings.host.browserTools.title,
      warning: zhCN.settings.host.browserTools.warning,
    });
    expect(getBrowserToolsMutationViewState({ isPending: true, error: null }).loadingText).toBe(
      zhCN.settings.host.browserTools.updating,
    );
  });
});
