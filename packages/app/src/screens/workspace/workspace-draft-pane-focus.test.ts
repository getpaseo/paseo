import { describe, expect, it } from "vitest";
import { shouldAutoFocusWorkspaceDraftComposer } from "./workspace-draft-pane-focus";

describe("shouldAutoFocusWorkspaceDraftComposer", () => {
  it("focuses the draft composer when the pane is focused and idle", () => {
    expect(
      shouldAutoFocusWorkspaceDraftComposer({
        isPaneFocused: true,
        isSubmitting: false,
      }),
    ).toBe(true);
  });

  it("does not focus the draft composer when the pane is unfocused", () => {
    expect(
      shouldAutoFocusWorkspaceDraftComposer({
        isPaneFocused: false,
        isSubmitting: false,
      }),
    ).toBe(false);
  });

  it("does not focus the draft composer while the draft is submitting", () => {
    expect(
      shouldAutoFocusWorkspaceDraftComposer({
        isPaneFocused: true,
        isSubmitting: true,
      }),
    ).toBe(false);
  });
});
