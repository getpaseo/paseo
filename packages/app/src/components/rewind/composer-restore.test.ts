import { describe, expect, test } from "vitest";
import { restoreComposerTextIfEmpty } from "./composer-restore";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";

describe("restoreComposerTextIfEmpty", () => {
  test("restores the rewound message when the composer is empty", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "",
        rewoundText: "message before rewind",
      }),
    ).toBe("message before rewind");
  });

  test("preserves an existing composer draft", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "keep this draft",
        rewoundText: "message before rewind",
      }),
    ).toBe("keep this draft");
  });
});

describe("shouldRestoreComposerForRewindMode", () => {
  test("restores only conversation-mutating rewind modes", () => {
    expect(shouldRestoreComposerForRewindMode("conversation")).toBe(true);
    expect(shouldRestoreComposerForRewindMode("files")).toBe(false);
    expect(shouldRestoreComposerForRewindMode("both")).toBe(true);
  });
});
