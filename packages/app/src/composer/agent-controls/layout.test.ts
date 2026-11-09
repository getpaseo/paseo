import { describe, expect, it } from "vitest";
import {
  composerToolbarGeometry,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveModelTriggerLabels,
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
      pluginItems: 0,
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
          pluginItems: 0,
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
          pluginItems: 0,
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
          pluginItems: 0,
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
        pluginItems: 0,
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

  it("condenses to make room for plugin items and keeps them in the overflow", () => {
    const base = {
      availableWidth: 430,
      currentDensity: "full" as const,
      geometry: POINTER,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        features: [],
        fontScale: 1,
        pluginItems: 0,
      },
    };

    expect(
      resolveComposerControlDensity({ ...base, controls: { ...base.controls, pluginItems: 0 } }),
    ).toBe("full");
    expect(
      resolveComposerControlDensity({ ...base, controls: { ...base.controls, pluginItems: 2 } }),
    ).toBe("condensed");
    expect(
      resolveComposerControlDensity({
        ...base,
        availableWidth: 250,
        controls: { ...base.controls, pluginItems: 2 },
      }),
    ).toBe("tight");
  });

  it("gives every toolbar control one shell and one glyph per role and control sizing", () => {
    const pointerGlyph = { size: 16, strokeWidth: 1.5, tone: "muted" };
    expect(POINTER).toEqual({
      controlSize: 28,
      glyphs: { icon: pointerGlyph, label: pointerGlyph },
      controlGap: 4,
      iconLabelGap: 4,
      labelPadding: 8,
      caretSize: 14,
    });
    expect(TOUCH).toMatchObject({
      controlSize: 20,
      glyphs: {
        icon: { size: 20, strokeWidth: 1.5, tone: "foreground" },
        label: { size: 20, strokeWidth: 1.5, tone: "foreground" },
      },
      controlGap: 20,
    });
  });

  it("budgets touch-sized controls, so a touch toolbar condenses at a width a pointer one fits", () => {
    const input = {
      availableWidth: 400,
      currentDensity: "full" as const,
      controls: {
        hasModel: true,
        hasThinking: true,
        hasMode: true,
        features: [{ type: "toggle" as const }],
        fontScale: 1,
        pluginItems: 0,
      },
    };

    expect(resolveComposerControlDensity({ ...input, geometry: POINTER })).toBe("full");
    expect(resolveComposerControlDensity({ ...input, geometry: TOUCH })).toBe("condensed");
  });

  describe("touch toolbar on an iPad in portrait, sidebar docked", () => {
    // Codex: model, thinking, mode and two toggle features. Touch controls lay out at what they
    // paint, 20pt apart, so icon-only thinking, mode and features need 200.
    const controls = {
      hasModel: true,
      hasThinking: true,
      hasMode: true,
      features: [{ type: "toggle" as const }, { type: "toggle" as const }],
      fontScale: 1,
      pluginItems: 0,
    };

    it("keeps the model family label with icon-only controls on an empty draft", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 280,
          currentDensity: "full",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("tight");
    });

    it("keeps the icon-only controls once an attachment brings in send", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 240,
          currentDensity: "tight",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("tight");
    });

    it("folds thinking, mode and features into the model control below their width", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 180,
          currentDensity: "tight",
          geometry: TOUCH,
          controls,
        }),
      ).toBe("compact");
    });

    it("drops the model label only after the controls are folded", () => {
      expect(
        resolveComposerControlDensity({
          availableWidth: 64,
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
        pluginItems: 0,
      },
    };

    expect(resolveComposerControlDensity({ ...input, availableWidth: 600 })).toBe("compact");
    // The thinking label is not budgeted: it gives way before the model family label does.
    expect(resolveComposerControlDensity({ ...input, availableWidth: 96 })).toBe("compact");
    expect(resolveComposerControlDensity({ ...input, availableWidth: 64 })).toBe("iconOnly");
  });
});

describe("folded model control labels", () => {
  it("shows the thinking label while the model label fits beside it in full", () => {
    expect(
      resolveModelTriggerLabels({
        hasThinking: true,
        measurements: { availableWidth: 191, fullWidth: 190 },
      }),
    ).toBe("modelAndThinking");
  });

  it("hides the thinking label when rounded widths tie", () => {
    // On the web, 203.14 of labels and a 203 frame both report 203.
    expect(
      resolveModelTriggerLabels({
        hasThinking: true,
        measurements: { availableWidth: 203, fullWidth: 203 },
      }),
    ).toBe("model");
  });

  it("hides the thinking label before the model label would truncate", () => {
    expect(
      resolveModelTriggerLabels({
        hasThinking: true,
        measurements: { availableWidth: 189.5, fullWidth: 190 },
      }),
    ).toBe("model");
    expect(
      resolveModelTriggerLabels({
        hasThinking: true,
        measurements: { availableWidth: 90, fullWidth: 190 },
      }),
    ).toBe("model");
  });

  it("decides nothing until both widths are measured", () => {
    expect(resolveModelTriggerLabels({ hasThinking: true, measurements: {} })).toBe("measuring");
    expect(
      resolveModelTriggerLabels({ hasThinking: true, measurements: { availableWidth: 300 } }),
    ).toBe("measuring");
    expect(resolveModelTriggerLabels({ hasThinking: true, measurements: { fullWidth: 120 } })).toBe(
      "measuring",
    );
  });

  it("needs no measurement without a thinking label", () => {
    expect(resolveModelTriggerLabels({ hasThinking: false, measurements: {} })).toBe("model");
  });
});
