import { describe, expect, it } from "vitest";
import {
  composerToolbarGeometry,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
} from "./layout";

const POINTER = composerToolbarGeometry("pointer");
const TOUCH = composerToolbarGeometry("touch");

describe("composer control layout", () => {
  it("removes labels, then folds controls, then drops the model label as the toolbar narrows", () => {
    expect(resolveComposerControlPresentation("full")).toEqual({
      showCarets: true,
      showThinkingLabel: true,
      showModeLabel: true,
      aggregateFeatures: false,
      foldControls: false,
      showModelLabel: true,
    });
    expect(resolveComposerControlPresentation("condensed")).toMatchObject({
      showCarets: false,
      showThinkingLabel: false,
      showModeLabel: true,
      aggregateFeatures: true,
      foldControls: false,
    });
    expect(resolveComposerControlPresentation("tight")).toMatchObject({
      showModeLabel: false,
      foldControls: false,
      showModelLabel: true,
    });
    expect(resolveComposerControlPresentation("compact")).toMatchObject({
      foldControls: true,
      showModelLabel: true,
    });
    expect(resolveComposerControlPresentation("iconOnly")).toMatchObject({
      foldControls: true,
      showModelLabel: false,
    });
  });

  it("uses local available width and hysteresis to avoid density churn", () => {
    const controls = {
      hasModel: true,
      hasThinking: true,
      hasMode: true,
      features: [{ type: "toggle" as const }],
      fontScale: 1,
    };

    expect(
      resolveComposerControlDensity({
        availableWidth: 420,
        currentDensity: "full",
        geometry: POINTER,
        controls,
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        availableWidth: 380,
        currentDensity: "full",
        geometry: POINTER,
        controls,
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        availableWidth: 290,
        currentDensity: "condensed",
        geometry: POINTER,
        controls,
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        availableWidth: 280,
        currentDensity: "condensed",
        geometry: POINTER,
        controls,
      }),
    ).toBe("tight");
    expect(
      resolveComposerControlDensity({
        availableWidth: 300,
        currentDensity: "tight",
        geometry: POINTER,
        controls,
      }),
    ).toBe("tight");
    expect(
      resolveComposerControlDensity({
        availableWidth: 312,
        currentDensity: "tight",
        geometry: POINTER,
        controls,
      }),
    ).toBe("condensed");
  });

  it("budgets extra features and larger text before restoring full labels", () => {
    const base = {
      availableWidth: 430,
      currentDensity: "condensed" as const,
      geometry: POINTER,
    };

    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }],
          fontScale: 1,
        },
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }, { type: "select", label: "Tools" }],
          fontScale: 1,
        },
      }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          hasModel: true,
          hasThinking: true,
          hasMode: true,
          features: [{ type: "toggle" }],
          fontScale: 1.25,
        },
      }),
    ).toBe("condensed");
  });

  it("condenses before a labeled feature would overflow", () => {
    const base = {
      availableWidth: 430,
      currentDensity: "full" as const,
      geometry: POINTER,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        fontScale: 1,
      },
    };

    expect(
      resolveComposerControlDensity({
        ...base,
        controls: { ...base.controls, features: [{ type: "toggle" }] },
      }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({
        ...base,
        controls: {
          ...base.controls,
          features: [{ type: "select", label: "A much longer localized feature label" }],
        },
      }),
    ).toBe("condensed");
  });

  it("gives every toolbar control one shell and one glyph per control sizing", () => {
    expect(POINTER).toEqual({
      controlSize: 28,
      glyphSize: 16,
      controlGap: 4,
      iconLabelGap: 4,
      labelPadding: 8,
      caretSize: 14,
    });
    expect(TOUCH).toMatchObject({ controlSize: 44, glyphSize: 20 });
  });

  it("budgets touch-sized controls, so a touch toolbar condenses at a width a pointer one fits", () => {
    const input = {
      availableWidth: 420,
      currentDensity: "full" as const,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        features: [{ type: "toggle" as const }],
        fontScale: 1,
      },
    };

    expect(resolveComposerControlDensity({ ...input, geometry: POINTER })).toBe("full");
    expect(resolveComposerControlDensity({ ...input, geometry: TOUCH })).toBe("condensed");
  });

  describe("touch toolbar on an iPad in portrait, sidebar docked", () => {
    // Codex: model, thinking, mode and two toggle features. The measured toolbar is 272 wide
    // with an empty draft and 224 once an attachment brings in the send button.
    const controls = {
      hasModel: true,
      hasThinking: true,
      hasMode: true,
      features: [{ type: "toggle" as const }, { type: "toggle" as const }],
      fontScale: 1,
    };

    it("keeps the model family label with icon-only controls on an empty draft", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 272,
          currentDensity: "full",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("tight");
    });

    it("folds thinking, mode and features into the model control once an attachment narrows it", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 224,
          currentDensity: "tight",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("compact");
    });

    it("drops the model label only after the controls are folded", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 120,
          currentDensity: "compact",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("iconOnly");
    });
  });

  it("starts a compact composer at the folded toolbar however wide it is", () => {
    const input = {
      currentDensity: "compact" as const,
      geometry: TOUCH,
      minimumDensity: "compact" as const,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        features: [],
        fontScale: 1,
      },
    };

    expect(resolveComposerControlDensity({ ...input, availableWidth: 600 })).toBe("compact");
    // The iPhone toolbar with an attachment: "GPT-6…" beside "Medium" still fits.
    expect(resolveComposerControlDensity({ ...input, availableWidth: 159 })).toBe("compact");
    expect(resolveComposerControlDensity({ ...input, availableWidth: 120 })).toBe("iconOnly");
  });
});
