import { describe, expect, it } from "vitest";
import {
  runCreateChatAgent,
  ModelSelectionValidationError,
  resolveNewWorkspaceSubmissionError,
  type NewWorkspaceComposerState,
  type SubmitDraftInput,
} from "./new-workspace-chat";
import { i18n } from "@/i18n/i18next";

function composer(overrides: Partial<NewWorkspaceComposerState> = {}): NewWorkspaceComposerState {
  return {
    selectedProvider: "codex",
    selectedMode: "auto",
    effectiveModelId: "",
    effectiveThinkingOptionId: "",
    featureValues: {},
    providerDefinitions: [
      { id: "codex", label: "Codex", description: "", defaultModeId: "auto", modes: [] },
    ],
    availableModels: [{ provider: "codex", id: "hidden-model", label: "Hidden model" }],
    allModelsHidden: true,
    isModelLoading: false,
    ...overrides,
  };
}

function submission(composerState: NewWorkspaceComposerState | null) {
  const effects: string[] = [];
  const drafts: SubmitDraftInput[] = [];
  const input: Parameters<typeof runCreateChatAgent>[0] = {
    payload: { text: "Test submission", attachments: [], cwd: "/project" },
    composerState,
    ensureWorkspace: async () => {
      effects.push("workspace");
      return { id: "workspace-1", workspaceDirectory: "/project" };
    },
    submitWorkspaceDraft: (draft) => {
      effects.push("draft");
      drafts.push(draft);
      return "navigated";
    },
    clearDraft: () => {
      effects.push("clear");
    },
    serverId: "server-1",
    draftKey: "draft-1",
    draftContextScopeKey: null,
    resolveClient: () => {
      throw new Error("resolveClient should not run in these tests");
    },
    isStillOnCreateScreen: () => true,
    supportsForgeSearch: true,
    labels: { composerStateRequired: "Composer required", selectModel: "Select model" },
  };
  return { input, effects, drafts };
}

describe("new workspace chat submission", () => {
  it("rejects hide-all before workspace creation or draft handoff", async () => {
    const { input, effects, drafts } = submission(composer());
    await expect(runCreateChatAgent(input)).rejects.toThrow(
      i18n.t("providerSelection.readiness.allModelsHidden"),
    );
    expect(effects).toEqual([]);
    expect(drafts).toEqual([]);
  });
  it("preserves an explicitly selected hidden model at handoff", async () => {
    const { input, effects, drafts } = submission(composer({ effectiveModelId: "hidden-model" }));
    await runCreateChatAgent(input);
    expect(effects).toEqual(["workspace", "draft"]);
    expect(drafts[0].composerState.effectiveModelId).toBe("hidden-model");
  });

  it("preserves explicit fork setup and remaps its directory", async () => {
    const { input, drafts } = submission(composer({ effectiveModelId: "hidden-model" }));
    input.forkDraftSetup = {
      sourceDirectory: "/original",
      setup: {
        cwd: "/original/src",
        provider: "codex",
        model: "hidden-model",
        modeId: "auto",
        thinkingOptionId: null,
        featureValues: {},
      },
    };
    await runCreateChatAgent(input);
    expect(drafts[0].initialSetup).toEqual({
      cwd: "/project/src",
      provider: "codex",
      model: "hidden-model",
      modeId: "auto",
      thinkingOptionId: null,
      featureValues: {},
    });
  });

  it("submits after a visible model is restored", async () => {
    const { input, effects, drafts } = submission(
      composer({ allModelsHidden: false, effectiveModelId: "restored-model" }),
    );
    await runCreateChatAgent(input);
    expect(effects).toEqual(["workspace", "draft"]);
    expect(drafts[0].composerState.effectiveModelId).toBe("restored-model");
  });

  it("keeps provider defaults working when discovery returns no models", async () => {
    const { input, effects } = submission(
      composer({ availableModels: [], allModelsHidden: false }),
    );
    await runCreateChatAgent(input);
    expect(effects).toEqual(["workspace", "draft"]);
  });

  it("blocks while model discovery is loading, including an explicit choice", async () => {
    const { input, effects } = submission(
      composer({ isModelLoading: true, effectiveModelId: "hidden-model" }),
    );
    await expect(runCreateChatAgent(input)).rejects.toThrow(
      i18n.t("providerSelection.readiness.modelDefaultsLoading"),
    );
    expect(effects).toEqual([]);
  });

  it("rejects an unresolved model when the catalogue is populated", async () => {
    const { input, effects } = submission(composer({ allModelsHidden: false }));
    await expect(runCreateChatAgent(input)).rejects.toThrow(
      i18n.t("providerSelection.readiness.noModelAvailable"),
    );
    expect(effects).toEqual([]);
  });

  it("allows an attachment-only submission with a model", async () => {
    const { input, effects } = submission(composer({ effectiveModelId: "hidden-model" }));
    input.payload = {
      cwd: "/project",
      text: "",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "image-1",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "image-1",
            createdAt: 0,
          },
        },
      ],
    };
    await runCreateChatAgent(input);
    expect(effects).toEqual(["workspace", "draft"]);
  });

  it("retains the draft when workspace creation fails", async () => {
    const { input, effects, drafts } = submission(composer({ effectiveModelId: "hidden-model" }));
    input.ensureWorkspace = async () => {
      throw new Error("Host disconnected");
    };
    await expect(runCreateChatAgent(input)).rejects.toThrow("Host disconnected");
    expect(effects).toEqual([]);
    expect(drafts).toEqual([]);
  });
});

describe("new workspace selection error recovery", () => {
  it("recomputes only model-selection errors when the selection recovers", () => {
    const error = new ModelSelectionValidationError("old translated message");
    expect(resolveNewWorkspaceSubmissionError(error, composer())).toBe(
      i18n.t("providerSelection.readiness.allModelsHidden"),
    );
    expect(
      resolveNewWorkspaceSubmissionError(error, composer({ effectiveModelId: "hidden-model" })),
    ).toBeNull();
    expect(
      resolveNewWorkspaceSubmissionError(
        error,
        composer({ allModelsHidden: false, effectiveModelId: "visible" }),
      ),
    ).toBeNull();
    expect(
      resolveNewWorkspaceSubmissionError(
        "Host disconnected",
        composer({ effectiveModelId: "visible" }),
      ),
    ).toBe("Host disconnected");
    expect(
      resolveNewWorkspaceSubmissionError(
        "Workspace creation failed",
        composer({ effectiveModelId: "visible" }),
      ),
    ).toBe("Workspace creation failed");
  });
  it("marks rejected hide-all as a selection failure without changing the prompt", async () => {
    const { input } = submission(composer());
    await expect(runCreateChatAgent(input)).rejects.toBeInstanceOf(ModelSelectionValidationError);
    expect(input.payload.text).toBe("Test submission");
  });
});
