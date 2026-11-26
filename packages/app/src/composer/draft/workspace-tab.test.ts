import { describe, expect, test } from "vitest";

import {
  resolveDraftSubmitSelection,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "./workspace-tab-core";

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    isConnected: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("reports an offline host before an absent catalog or pending model defaults", () => {
    expect(
      validate({
        isConnected: false,
        composerState: {
          ...baseComposerState,
          providerDefinitions: [],
          selectedProvider: null,
          isModelLoading: true,
        },
      }),
    ).toBe("Host is not connected");
  });

  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });
});

describe("resolveDraftSubmitSelection", () => {
  const implicitSource = {
    model: "implicit",
    modeId: "implicit",
    thinkingOptionId: "implicit",
  } as const;
  const explicitSource = {
    model: "explicit",
    modeId: "explicit",
    thinkingOptionId: "explicit",
  } as const;

  test("omits implicit model/mode and flags the selection as implicit", () => {
    expect(
      resolveDraftSubmitSelection({
        autoSubmitConfig: null,
        selectionSource: implicitSource,
        effectiveModelId: "gpt-5.4",
        effectiveModeId: "auto",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({ selectionSource: "implicit" });
  });

  test("submits explicitly picked model and mode unchanged", () => {
    expect(
      resolveDraftSubmitSelection({
        autoSubmitConfig: null,
        selectionSource: explicitSource,
        effectiveModelId: "gpt-5.4",
        effectiveModeId: "auto",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({ modeId: "auto", model: "gpt-5.4", thinkingOptionId: "high" });
  });

  test("keeps an explicit mode when only the mode was picked", () => {
    expect(
      resolveDraftSubmitSelection({
        autoSubmitConfig: null,
        selectionSource: { model: "implicit", modeId: "explicit", thinkingOptionId: "implicit" },
        effectiveModelId: "gpt-5.4",
        effectiveModeId: "auto",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({ modeId: "auto", selectionSource: "implicit" });
  });

  test("keeps an explicitly picked thinking option even when the model is implicit", () => {
    expect(
      resolveDraftSubmitSelection({
        autoSubmitConfig: null,
        selectionSource: { model: "implicit", modeId: "implicit", thinkingOptionId: "explicit" },
        effectiveModelId: "gpt-5.4",
        effectiveModeId: "auto",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({ thinkingOptionId: "high", selectionSource: "implicit" });
  });

  test("auto-submit keeps the legacy resolved behavior without the implicit flag", () => {
    expect(
      resolveDraftSubmitSelection({
        autoSubmitConfig: { modeId: null, model: null, thinkingOptionId: null },
        selectionSource: implicitSource,
        effectiveModelId: "gpt-5.4",
        effectiveModeId: "auto",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({ modeId: "auto", model: "gpt-5.4", thinkingOptionId: "high" });
  });
});
