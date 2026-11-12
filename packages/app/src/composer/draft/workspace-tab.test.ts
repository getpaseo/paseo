import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import { keyedDraftAgentRequest } from "./creation-key";

import { shouldAllowEmptyDraftText, validateDraftSubmission } from "./workspace-tab-core";

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

const request = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  workspaceId: "workspace-1",
  initialPrompt: "Build this",
  clientMessageId: "draft-1:initial-message",
};

describe("draft agent creation identity after a timeout", () => {
  it("uses the standard SHA-256 fingerprint without a native or WebCrypto bridge", async () => {
    const keyed = await keyedDraftAgentRequest("draft-1", { initialPrompt: "日本語 🚀" });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ initialPrompt: "日本語 🚀" }))
      .digest("hex");
    expect(keyed.idempotencyKey).toBe(`draft-1:${fingerprint}`);
  });
  it("reuses the identity when resubmitting unchanged inputs, including after remount", async () => {
    const first = await keyedDraftAgentRequest("draft-1", request);
    const retry = await keyedDraftAgentRequest("draft-1", {
      ...request,
      config: { model: "gpt-6", cwd: "/repo", provider: "codex" },
    });
    expect(retry).toEqual(first);
  });

  it.each([
    { initialPrompt: "Try something else" },
    { config: { ...request.config, model: "gpt-6-mini" } },
    { config: { ...request.config, provider: "claude" } },
    { config: { ...request.config, providerOptions: { effort: "high" } } },
    { metadata: { "issues.key": "PAS-1" } },
    { attachments: [{ type: "text" as const, text: "Context", mimeType: "text/plain" as const }] },
    { images: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
  ])("starts a new intent when the failed draft is edited: %j", async (edit) => {
    const first = await keyedDraftAgentRequest("draft-1", request);
    const next = await keyedDraftAgentRequest("draft-1", { ...request, ...edit });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(next).toMatchObject({ ...request, ...edit });
    expect(await keyedDraftAgentRequest("draft-1", { ...request, ...edit })).toEqual(next);
  });

  it("keeps identical submissions in different draft tabs independent", async () => {
    const first = await keyedDraftAgentRequest("draft-1", request);
    const next = await keyedDraftAgentRequest("draft-2", request);
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
