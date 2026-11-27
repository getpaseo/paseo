import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStagedProviderSwitch,
  getStagedProviderSwitch,
  settleStagedProviderSwitch,
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

  it("settles only the draft that was sent and preserves any newer selection or edit", () => {
    const store = useStagedProviderSwitchStore.getState();
    store.stage("srv-1", "agent-1", {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });
    const sentDraft = getStagedProviderSwitch("srv-1", "agent-1")!;

    // User chooses Copilot before Codex reply returns -> settling Codex draft preserves Copilot.
    store.stage("srv-1", "agent-1", {
      provider: "copilot",
      model: "gpt-5",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });
    settleStagedProviderSwitch("srv-1", "agent-1", sentDraft);
    const copilotDraft = getStagedProviderSwitch("srv-1", "agent-1")!;
    expect(copilotDraft.provider).toBe("copilot");

    // Patching the draft also produces a newer revision that settling the older reference preserves.
    store.patch("srv-1", "agent-1", (current) => ({ ...current, thinkingOptionId: "high" }));
    settleStagedProviderSwitch("srv-1", "agent-1", copilotDraft);
    const patchedCopilot = getStagedProviderSwitch("srv-1", "agent-1")!;
    expect(patchedCopilot.thinkingOptionId).toBe("high");

    // Settling the current draft clears it cleanly.
    settleStagedProviderSwitch("srv-1", "agent-1", patchedCopilot);
    expect(getStagedProviderSwitch("srv-1", "agent-1")).toBeNull();
  });
});
