import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  draftControlsRequest,
  openDraftOptions,
  shownDraftOptions,
} from "@/agent-controls/draft-options-model";
import { openAgentForm, type AgentFormCatalog } from "@/provider-selection/agent-form-store";
import { draftComposerAgent } from "./composer-agent";

function definition(id: string, modeId: string): AgentProviderDefinition {
  return {
    id,
    label: id,
    description: id,
    defaultModeId: modeId,
    modes: [{ id: modeId, label: modeId, icon: "ShieldCheck", colorTier: "safe" }],
  };
}

function model(provider: string, id: string, isDefault = false): AgentModelDefinition {
  return { provider, id, label: id, isDefault };
}

/** The host: two providers with catalogs, and one that is ready but lists no models. */
const catalog: AgentFormCatalog = {
  selectableProviders: new Map([
    ["claude", definition("claude", "default")],
    ["codex", definition("codex", "auto")],
    ["opencode", definition("opencode", "build")],
  ]),
  models: new Map([
    ["claude", [model("claude", "sonnet", true)]],
    ["codex", [model("codex", "gpt-5.4", true), model("codex", "gpt-5.5")]],
    ["opencode", []],
  ]),
  providerPreferences: () => undefined,
};

/** A draft composer on the real form and options models. */
function openDraft(context: "draft" | "new-workspace") {
  const form = openAgentForm(() => catalog);
  const options = openDraftOptions({
    provider: null,
    currentProvider: () => form.getState().form.provider,
  });
  // The screen hands the options the provider the form reaches.
  form.subscribe(() => options.observeProvider(form.getState().form.provider));
  form.setProviderAndModel("claude", "");

  function agent() {
    const { form: current } = form.getState();
    return draftComposerAgent({
      context,
      selectedProvider: current.provider,
      selectedModel: current.model,
      selectedMode: current.modeId,
      thinking: current.thinkingOptionId || null,
      options: shownDraftOptions(options.getState(), {
        provider: current.provider,
        requestKey: "",
      }),
      metadata: {},
      onSelectProviderAndModel: form.setProviderAndModel,
      onSelectModel: form.setModel,
      onSelectMode: () => undefined,
      onSelectThinkingOption: () => undefined,
      onSetOption: options.setOption,
      onSetMetadata: () => undefined,
    });
  }

  /** What the daemon is asked to resolve for the agent this draft would create. */
  function request() {
    const { form: current } = form.getState();
    return draftControlsRequest(options.getState(), {
      provider: current.provider,
      cwd: "/repo",
      modeId: current.modeId,
      modelId: current.model,
    });
  }

  return { form, agent, request };
}

describe.each(["draft", "new-workspace"] as const)("the %s composer's agent", (context) => {
  it("applies each awaited command before the next one runs", async () => {
    const draft = openDraft(context);
    // A plugin keeps the object it was handed across its awaits.
    const retained = draft.agent();

    await retained.setProvider("codex");
    await retained.setModel("gpt-5.5");
    await retained.setOptions({ context: "1m" });

    const agent = draft.agent();
    expect(agent).toMatchObject({
      context,
      provider: "codex",
      model: "gpt-5.5",
      options: { context: "1m" },
    });
    expect(draft.request()).toMatchObject({
      provider: "codex",
      model: "gpt-5.5",
      providerOptions: { context: "1m" },
    });
  });

  it("starts the options over when the provider is chosen by hand", async () => {
    const draft = openDraft(context);
    const retained = draft.agent();

    await retained.setOptions({ context: "1m" });
    expect(draft.agent().options).toEqual({ context: "1m" });
    await retained.setProvider("codex");

    expect(draft.agent().options).toEqual({});
  });

  it("rejects a provider the host cannot run and a model the catalog does not list", async () => {
    const draft = openDraft(context);
    const retained = draft.agent();

    await expect(retained.setProvider("nope")).rejects.toThrow(
      "Unknown or unavailable provider: nope",
    );
    expect(draft.agent().provider).toBe("claude");

    await retained.setProvider("codex");
    await expect(retained.setModel("missing")).rejects.toThrow("Unknown model: missing");
    expect(draft.agent()).toMatchObject({ provider: "codex", model: "gpt-5.4" });
  });

  it("keeps a model id as given when the provider lists no catalog", async () => {
    const draft = openDraft(context);
    const retained = draft.agent();

    await retained.setProvider("opencode");
    await retained.setModel("anthropic/claude-x");

    expect(draft.agent().model).toBe("anthropic/claude-x");
  });
});
