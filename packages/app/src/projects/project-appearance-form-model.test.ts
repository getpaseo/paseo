import { describe, expect, it } from "vitest";
import {
  openProjectAppearanceForm,
  type ProjectAppearanceFormSnapshot,
} from "./project-appearance-form-model";

const labels: ProjectAppearanceFormSnapshot["labels"] = {
  automatic: "Automatic",
  favicon: "Favicon URL",
  custom: "Custom",
  urlRequired: "Enter a favicon URL",
  customRequired: "Enter 1 to 8 characters",
};

describe("project appearance form model", () => {
  it("seeds the saved appearance", () => {
    const model = openProjectAppearanceForm({
      appearance: {
        icon: { type: "custom", text: "🚀" },
        color: "transparent",
        revision: "1",
      },
      labels,
    });

    expect(model.getState()).toMatchObject({
      mode: "custom",
      customText: "🚀",
      color: "transparent",
      selectedDisplay: { label: "Custom" },
      showCustomText: true,
      canSubmit: true,
    });
  });

  it("owns disclosure and validation", () => {
    const model = openProjectAppearanceForm({ appearance: null, labels });

    model.setMode("favicon");
    expect(model.getState()).toMatchObject({
      showFaviconUrl: true,
      valueError: "Enter a favicon URL",
      canSubmit: false,
    });

    model.setFaviconUrl(" https://example.com ");
    expect(model.getState()).toMatchObject({
      valueError: null,
      canSubmit: true,
      input: { icon: { type: "favicon", url: "https://example.com" } },
    });
  });

  it("builds a trimmed custom appearance payload", () => {
    const model = openProjectAppearanceForm({ appearance: null, labels });

    model.setMode("custom");
    model.setCustomText(" 🚀 ");
    model.setColor("#8B5CF6");

    expect(model.getState().input).toEqual({
      icon: { type: "custom", text: "🚀" },
      color: "#8b5cf6",
    });
  });
});
