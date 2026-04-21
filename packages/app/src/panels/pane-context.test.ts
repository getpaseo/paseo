import { describe, expect, it } from "vitest";
import { createPaneFocusContextValue } from "@/panels/pane-context";

describe("createPaneFocusContextValue", () => {
  it("derives interactivity from both workspace and pane focus", () => {
    expect(
      createPaneFocusContextValue({
        isWorkspaceFocused: true,
        isPaneFocused: true,
      }),
    ).toEqual({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isInteractive: true,
    });
    expect(
      createPaneFocusContextValue({
        isWorkspaceFocused: false,
        isPaneFocused: true,
      }),
    ).toEqual({
      isWorkspaceFocused: false,
      isPaneFocused: true,
      isInteractive: false,
    });
  });
});
