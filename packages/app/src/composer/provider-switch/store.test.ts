import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStagedProviderSwitch,
  getStagedProviderSwitch,
  useStagedProviderSwitchStore,
} from "./index";

describe("staged provider switch store", () => {
  beforeEach(() => {
    useStagedProviderSwitchStore.setState({ stagedByKey: new Map() });
  });

  it("stages, patches, and clears per server and agent", () => {
    const store = useStagedProviderSwitchStore.getState();
    store.stage("srv-1", "agent-1", {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      modeId: "auto",
      providerOptions: { fast_mode: true },
    });
    store.stage("srv-1", "agent-2", {
      provider: "opencode",
      model: null,
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });

    expect(getStagedProviderSwitch("srv-1", "agent-1")).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      modeId: "auto",
      providerOptions: { fast_mode: true },
    });

    store.patch("srv-1", "agent-1", (current) => ({
      ...current,
      thinkingOptionId: "medium",
    }));
    expect(getStagedProviderSwitch("srv-1", "agent-1")?.thinkingOptionId).toBe("medium");

    clearStagedProviderSwitch("srv-1", "agent-1");
    expect(getStagedProviderSwitch("srv-1", "agent-1")).toBeNull();
    expect(getStagedProviderSwitch("srv-1", "agent-2")?.provider).toBe("opencode");

    store.clearForServer("srv-1");
    expect(getStagedProviderSwitch("srv-1", "agent-2")).toBeNull();
  });
});
