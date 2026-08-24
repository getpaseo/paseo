import { describe, expect, it } from "vitest";

import { buildConfirmMessageBoxOptions, CONFIRM_BUTTON_INDEX } from "./dialogs.js";

describe("buildConfirmMessageBoxOptions", () => {
  // Regression: `paseo:dialog:ask` and `paseo:dialog:askWithCheckbox` both used to
  // inline `defaultId: 1` / `cancelId: 0`. Extracting the builder must not shift
  // which button Enter and Escape activate for either of them.
  it("keeps Enter on OK and Escape on Cancel by default", () => {
    const options = buildConfirmMessageBoxOptions({ message: "Delete it?" });

    expect(options.buttons).toEqual(["Cancel", "OK"]);
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(0);
    expect(options.title).toBe("Confirm");
    expect(options.type).toBe("question");
  });

  it("moves Enter to Cancel for dialogs guarding a destructive action", () => {
    const options = buildConfirmMessageBoxOptions({
      message: "Quit Paseo?",
      defaultButton: "cancel",
    });

    // Cancel is index 0 in both roles, so Enter and Escape agree.
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    // The confirming button is still present and still index 1.
    expect(options.buttons?.[CONFIRM_BUTTON_INDEX]).toBe("OK");
  });

  it("keeps Cancel at the index the confirm check depends on", () => {
    const options = buildConfirmMessageBoxOptions({
      message: "Quit?",
      okLabel: "Quit",
      cancelLabel: "Keep working",
    });

    expect(options.buttons?.[CONFIRM_BUTTON_INDEX]).toBe("Quit");
    expect(options.buttons?.[options.cancelId!]).toBe("Keep working");
  });

  it("maps the dialog kind onto Electron message box types", () => {
    expect(buildConfirmMessageBoxOptions({ message: "m", kind: "warning" }).type).toBe("warning");
    expect(buildConfirmMessageBoxOptions({ message: "m", kind: "error" }).type).toBe("error");
    expect(buildConfirmMessageBoxOptions({ message: "m", kind: "info" }).type).toBe("question");
  });

  it("omits checkbox fields entirely when no checkbox was requested", () => {
    const options = buildConfirmMessageBoxOptions({ message: "m" });

    expect(options).not.toHaveProperty("checkboxLabel");
    expect(options).not.toHaveProperty("checkboxChecked");
  });

  it("defaults the checkbox to unchecked when a label is given", () => {
    const options = buildConfirmMessageBoxOptions({
      message: "m",
      checkboxLabel: "Don't ask again",
    });

    expect(options.checkboxLabel).toBe("Don't ask again");
    expect(options.checkboxChecked).toBe(false);
  });
});
