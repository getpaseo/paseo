import { describe, expect, it } from "vitest";
import {
  buildDraftComposerCommandConfig,
  createAgentInputDraftCore,
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
} from "./use-agent-input-draft-core";

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: async (key: string) => {
      map.delete(key);
    },
  };
}

describe("resolveDraftKey", () => {
  it("returns a string draft key unchanged", () => {
    expect(
      resolveDraftKey({
        draftKey: "draft:key",
        selectedServerId: "host-1",
      }),
    ).toBe("draft:key");
  });

  it("resolves a computed draft key from the selected server", () => {
    expect(
      resolveDraftKey({
        draftKey: ({ selectedServerId }) => `draft:${selectedServerId ?? "none"}`,
        selectedServerId: "host-1",
      }),
    ).toBe("draft:host-1");
  });
});

describe("resolveEffectiveComposerModelId", () => {
  it("returns the selected model trimmed", () => {
    expect(
      resolveEffectiveComposerModelId({
        selectedModel: "  gpt-5.4-mini  ",
        availableModels: [],
      }),
    ).toBe("gpt-5.4-mini");
  });

  it("returns empty string when no model selected", () => {
    expect(
      resolveEffectiveComposerModelId({
        selectedModel: "",
        availableModels: [],
      }),
    ).toBe("");
  });
});

describe("resolveEffectiveComposerThinkingOptionId", () => {
  const models = [
    {
      provider: "codex",
      id: "gpt-5.4",
      label: "gpt-5.4",
      isDefault: true,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
  ];

  it("prefers the selected thinking option when present", () => {
    expect(
      resolveEffectiveComposerThinkingOptionId({
        selectedThinkingOptionId: "medium",
        availableModels: models,
        effectiveModelId: "gpt-5.4",
      }),
    ).toBe("medium");
  });

  it("falls back to the model default thinking option", () => {
    expect(
      resolveEffectiveComposerThinkingOptionId({
        selectedThinkingOptionId: "",
        availableModels: models,
        effectiveModelId: "gpt-5.4",
      }),
    ).toBe("high");
  });
});

describe("buildDraftComposerCommandConfig", () => {
  it("returns undefined when cwd is empty", () => {
    expect(
      buildDraftComposerCommandConfig({
        provider: "codex",
        cwd: "  ",
        modeOptions: [],
        selectedMode: "",
        effectiveModelId: "gpt-5.4",
        effectiveThinkingOptionId: "high",
      }),
    ).toBeUndefined();
  });

  it("builds the draft command config from derived composer state", () => {
    expect(
      buildDraftComposerCommandConfig({
        provider: "codex",
        cwd: "/repo",
        modeOptions: [{ id: "auto", label: "Auto" }],
        selectedMode: "auto",
        effectiveModelId: "gpt-5.4",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });
});

describe("createAgentInputDraftCore", () => {
  it("load returns null when nothing has been saved", async () => {
    const core = createAgentInputDraftCore({ storage: makeStorage(), storageKey: "test" });
    expect(await core.load()).toBeNull();
  });

  it("load returns the draft that was saved", async () => {
    const core = createAgentInputDraftCore({ storage: makeStorage(), storageKey: "test" });
    await core.save({ text: "hello world", attachments: [], cwd: "/repo" });
    expect(await core.load()).toEqual({ text: "hello world", attachments: [], cwd: "/repo" });
  });

  it("clear removes the persisted draft", async () => {
    const core = createAgentInputDraftCore({ storage: makeStorage(), storageKey: "test" });
    await core.save({ text: "hello", attachments: [], cwd: "/repo" });
    await core.clear();
    expect(await core.load()).toBeNull();
  });

  it("load seeds cwd from initialCwd when cwd is absent from stored data", async () => {
    const storage = makeStorage();
    await storage.setItem("test", JSON.stringify({ text: "hello", attachments: [] }));

    const core = createAgentInputDraftCore({ storage, storageKey: "test" });
    const draft = await core.load("/initial");
    expect(draft?.cwd).toBe("/initial");
  });

  it("round-trips attachments unchanged", async () => {
    const attachment = {
      kind: "github_issue" as const,
      item: {
        kind: "issue" as const,
        number: 42,
        title: "Unify attachments",
        url: "https://github.com/example/repo/issues/42",
        state: "open" as const,
        body: "body",
        labels: ["composer"],
      },
    };
    const core = createAgentInputDraftCore({ storage: makeStorage(), storageKey: "test" });
    await core.save({ text: "", attachments: [attachment], cwd: "/repo" });
    const draft = await core.load();
    expect(draft?.attachments).toEqual([attachment]);
  });

  it("isolated keys do not share state", async () => {
    const storage = makeStorage();
    const a = createAgentInputDraftCore({ storage, storageKey: "key-a" });
    const b = createAgentInputDraftCore({ storage, storageKey: "key-b" });
    await a.save({ text: "from a", attachments: [], cwd: "" });
    expect(await b.load()).toBeNull();
    expect(await a.load()).toMatchObject({ text: "from a" });
  });
});
