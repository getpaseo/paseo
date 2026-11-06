import { describe, expect, test } from "vitest";
import { restoreComposerPromptIfEmpty } from "./composer-restore";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";

describe("restoreComposerPromptIfEmpty", () => {
  test("restores the rewound message when the composer is empty", () => {
    expect(
      restoreComposerPromptIfEmpty({
        currentText: "",
        rewoundPrompt: { text: "message before rewind" },
      }),
    ).toEqual({ text: "message before rewind" });
  });

  test("preserves an existing composer draft", () => {
    expect(
      restoreComposerPromptIfEmpty({
        currentText: "keep this draft",
        rewoundPrompt: { text: "message before rewind" },
      }),
    ).toEqual({ text: "keep this draft" });
  });
});

test.each(["", "Continue here"])("restores inherited history with rewound prompt %s", (text) => {
  const chatHistory = {
    type: "text",
    mimeType: "text/plain",
    contextKind: "chat_history",
    text: "Earlier context",
  } as const;
  expect(
    restoreComposerPromptIfEmpty({ currentText: "", rewoundPrompt: { text, chatHistory } }),
  ).toEqual({ text, chatHistory });
  expect(
    restoreComposerPromptIfEmpty({
      currentText: "Existing draft",
      rewoundPrompt: { text, chatHistory },
    }),
  ).toEqual({ text: "Existing draft" });
});

describe("shouldRestoreComposerForRewindMode", () => {
  test("restores only conversation-mutating rewind modes", () => {
    expect(shouldRestoreComposerForRewindMode("conversation")).toBe(true);
    expect(shouldRestoreComposerForRewindMode("files")).toBe(false);
    expect(shouldRestoreComposerForRewindMode("both")).toBe(true);
  });
});
