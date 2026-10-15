import { describe, expect, it } from "vitest";
import { openPluginInstallForm } from "./plugin-install-form-model";

describe("plugin install form", () => {
  it("keeps the edited source in the submission until explicitly reset", () => {
    const model = openPluginInstallForm();

    model.setSource("owner/review");

    expect(model.getSubmission()).toEqual({ source: "owner/review" });

    model.reset();
    expect(model.getState()).toEqual({
      source: "",
      canSubmit: false,
      resetKey: 1,
    });
  });

  it("trims the submitted source", () => {
    const model = openPluginInstallForm();
    model.setSource("  /plugins/review  ");
    expect(model.getSubmission()).toEqual({ source: "/plugins/review" });
  });
});
