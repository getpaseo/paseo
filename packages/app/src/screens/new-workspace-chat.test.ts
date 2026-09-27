import { describe, expect, it } from "vitest";
import type { MessagePayload } from "@/composer/types";
import {
  assertNewWorkspaceChatSubmission,
  ModelSelectionValidationError,
  resolveNewWorkspaceSubmissionError,
  type NewWorkspaceComposerState,
} from "./new-workspace-chat";
import { i18n } from "@/i18n/i18next";

function composer(overrides: Partial<NewWorkspaceComposerState> = {}): NewWorkspaceComposerState {
  return {
    selectedProvider: "codex",
    effectiveModelId: "",
    providerDefinitions: [
      { id: "codex", label: "Codex", description: "", defaultModeId: "auto", modes: [] },
    ],
    availableModels: [{ provider: "codex", id: "hidden-model", label: "Hidden model" }],
    allModelsHidden: true,
    isModelLoading: false,
    ...overrides,
  };
}

function submission(
  composerState: NewWorkspaceComposerState,
  payload: Partial<MessagePayload> = {},
) {
  return () =>
    assertNewWorkspaceChatSubmission({
      payload: { text: "Test submission", attachments: [], cwd: "/project", ...payload },
      composerState,
    });
}

describe("new workspace chat submission", () => {
  it("rejects hide-all as a model-selection failure", () => {
    const submit = submission(composer());
    expect(submit).toThrow(i18n.t("providerSelection.readiness.allModelsHidden"));
    expect(submit).toThrow(ModelSelectionValidationError);
  });

  it("accepts an explicitly selected hidden model", () => {
    expect(submission(composer({ effectiveModelId: "hidden-model" }))).not.toThrow();
  });

  it("accepts a submission after a visible model is restored", () => {
    expect(
      submission(composer({ allModelsHidden: false, effectiveModelId: "restored-model" })),
    ).not.toThrow();
  });

  it("keeps provider defaults working when discovery returns no models", () => {
    expect(submission(composer({ availableModels: [], allModelsHidden: false }))).not.toThrow();
  });

  it("blocks while model discovery is loading, including an explicit choice", () => {
    expect(
      submission(composer({ isModelLoading: true, effectiveModelId: "hidden-model" })),
    ).toThrow(i18n.t("providerSelection.readiness.modelDefaultsLoading"));
  });

  it("rejects an unresolved model when the catalogue is populated", () => {
    expect(submission(composer({ allModelsHidden: false }))).toThrow(
      i18n.t("providerSelection.readiness.noModelAvailable"),
    );
  });

  it("allows an attachment-only submission with a model", () => {
    const submit = submission(composer({ effectiveModelId: "hidden-model" }), {
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
    });
    expect(submit).not.toThrow();
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
});
