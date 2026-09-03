import { describe, expect, test } from "vitest";

import {
  completeWorkspaceDraftCreation,
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
    hasClient: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
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

describe("workspace draft creation handoff", () => {
  test("clears the Android composer and waits two rendered frames before replacing the tab", async () => {
    const events: string[] = [];
    const pendingFrames: Array<() => void> = [];
    const handoff = completeWorkspaceDraftCreation({
      platform: "android",
      result: "created-agent",
      clearDraftState: () => events.push("clear"),
      onCreated: (result) => events.push(`created:${result}`),
      requestFrame: (callback) => pendingFrames.push(callback),
    });

    expect(events).toEqual(["clear"]);
    expect(pendingFrames).toHaveLength(1);
    pendingFrames.shift()?.();
    await Promise.resolve();
    expect(events).toEqual(["clear"]);
    expect(pendingFrames).toHaveLength(1);

    pendingFrames.shift()?.();
    await handoff;
    expect(events).toEqual(["clear", "created:created-agent"]);
  });

  test.each(["ios", "web"])("hands off immediately on %s", async (platform) => {
    const events: string[] = [];
    let requestedFrames = 0;

    await completeWorkspaceDraftCreation({
      platform,
      result: "created-agent",
      clearDraftState: () => events.push("clear"),
      onCreated: (result) => events.push(`created:${result}`),
      requestFrame: () => {
        requestedFrames += 1;
      },
    });

    expect(events).toEqual(["clear", "created:created-agent"]);
    expect(requestedFrames).toBe(0);
  });
});
