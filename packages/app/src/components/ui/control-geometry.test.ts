import { describe, expect, it } from "vitest";
import {
  ALERT_ICON_SIZE,
  bySizing,
  CONTROL_HEIGHTS,
  controlHeightForLayout,
  controlSizingForLayout,
  createControlGeometry,
  HEADER_CONTROL_HEIGHT,
  ICON_BUTTON_SIZES,
  iconSizeFor,
  resolveControlSizing,
  switchGeometryForLayout,
  getControlInteractionPhase,
  TOOLBAR_CONTROL_GAP,
  TOOLBAR_CONTROL_GAPS,
  TOOLBAR_CONTROL_HEIGHT,
  TOOLBAR_CONTROL_SIZES,
  TOOLBAR_DISC_GLYPH_SIZES,
  TOOLBAR_DISC_SIZE,
  TOOLBAR_DISC_SIZES,
  TOOLBAR_GLYPH_SIZES,
  TOOLBAR_RINGS,
  toolbarGlyphColor,
  toolbarGlyphsFor,
  toolbarGlyphTone,
  toolbarSlot,
  TOUCH_TARGET,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";

const theme = {
  borderRadius: {
    md: 6,
    lg: 8,
    xl: 12,
    "2xl": 16,
    full: 9999,
  },
  borderWidth: {
    1: 1,
  },
  colors: {
    accent: "#20744A",
    borderAccent: "#2F3534",
  },
  fontSize: {
    xs: 10,
    sm: 12,
    base: 14,
    lg: 16,
  },
  opacity: {
    50: 0.5,
  },
  spacing: {
    0: 0,
    0.5: 2,
    1: 4,
    2: 8,
    3: 12,
    3.5: 14,
    4: 16,
    6: 24,
    7: 28,
    8: 32,
  },
} as unknown as Theme;

describe("control sizing gate", () => {
  it("is touch-sized in the compact layout or on a touch screen, and pointer-sized otherwise", () => {
    expect(resolveControlSizing({ compactLayout: true, touchScreen: true })).toBe("touch");
    expect(resolveControlSizing({ compactLayout: true, touchScreen: false })).toBe("touch");
    expect(resolveControlSizing({ compactLayout: false, touchScreen: true })).toBe("touch");
    expect(resolveControlSizing({ compactLayout: false, touchScreen: false })).toBe("pointer");
  });

  it("gives a touch screen its touch sizes at every width", () => {
    const sizes = { touch: 44, pointer: 32 };

    // An iPad: touch-sized in the docked desktop layout too.
    expect(bySizing(sizes, true)).toEqual({ xs: 44, md: 44 });
    // A mouse-driven window: touch-sized only once it narrows into the compact layout.
    expect(bySizing(sizes, false)).toEqual({ xs: 44, md: 32 });
  });

  it("keeps a device without a touch screen on pointer sizes from md up", () => {
    // The unit runtime has no touch screen, which is the desktop that must not change.
    expect(controlSizingForLayout(false)).toBe("pointer");
    expect(controlSizingForLayout(true)).toBe("touch");
    expect(CONTROL_HEIGHTS.md).toEqual({ xs: 44, md: 32 });
    expect(CONTROL_HEIGHTS.sm).toEqual({ xs: 32, md: 28 });
    expect(HEADER_CONTROL_HEIGHT).toEqual({ xs: 32, md: 26 });
  });

  it("follows the HIG on touch: a 44pt target, no control under 28pt, larger glyphs", () => {
    expect(TOUCH_TARGET).toBe(44);
    expect(controlHeightForLayout("md", true)).toBe(TOUCH_TARGET);
    expect(ICON_BUTTON_SIZES.large.touch).toBe(TOUCH_TARGET);
    expect(ICON_BUTTON_SIZES.small.touch).toBe(TOUCH_TARGET);
    // Composer toolbar controls: a full target on touch, unchanged 28 on pointer.
    expect(TOOLBAR_CONTROL_SIZES).toEqual({ touch: TOUCH_TARGET, pointer: 28 });
    expect(TOOLBAR_CONTROL_HEIGHT).toEqual({ xs: TOUCH_TARGET, md: 28 });
    // A filled toolbar control paints a 36pt disc inside its 44pt touch frame, and fills its
    // 28pt pointer frame exactly, so desktop is unchanged. Its glyph is the `md` glyph.
    expect(TOOLBAR_DISC_SIZES).toEqual({ touch: 36, pointer: TOOLBAR_CONTROL_SIZES.pointer });
    expect(TOOLBAR_DISC_SIZE).toEqual({ xs: 36, md: 28 });
    expect(iconSizeFor("md")).toEqual({ touch: 20, pointer: 16 });
    for (const size of ["sm", "md"] as const) {
      expect(controlHeightForLayout(size, true)).toBeGreaterThan(
        controlHeightForLayout(size, false),
      );
      expect(controlHeightForLayout(size, false)).toBeGreaterThanOrEqual(28);
    }
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(iconSizeFor(size).touch).toBeGreaterThan(iconSizeFor(size).pointer);
    }
  });
});

describe("toolbar glyphs and spacing", () => {
  it("spaces touch toolbar controls by what they paint and keeps the pointer's 4px gap", () => {
    expect(TOOLBAR_CONTROL_GAPS).toEqual({ touch: 20, pointer: 4 });
    expect(TOOLBAR_CONTROL_GAP).toEqual({ xs: 20, md: 4 });
    // A 20pt glyph's disc-sized frame reaches 8 into the gap on each side.
    expect(toolbarSlot(20)).toEqual({
      width: TOOLBAR_DISC_SIZE,
      height: TOOLBAR_DISC_SIZE,
      marginHorizontal: { xs: -8, md: 0 },
    });
  });

  it("paints touch toolbar glyphs at the header icons' 20pt and 1.5px stroke and leaves pointer unchanged", () => {
    const pointerGlyph = { size: 16, strokeWidth: 1.5, tone: "muted" };
    expect(toolbarGlyphsFor("touch").icon).toEqual({
      size: 20,
      strokeWidth: 1.5,
      tone: "foreground",
    });
    expect(toolbarGlyphsFor("pointer")).toEqual({ icon: pointerGlyph, label: pointerGlyph });
    expect(TOOLBAR_GLYPH_SIZES.icon).toEqual({ xs: 20, md: 16 });
    expect(toolbarGlyphsFor("touch").icon.size).toBeLessThan(TOOLBAR_CONTROL_SIZES.touch);
    expect(toolbarGlyphsFor("pointer").icon.size).toBeLessThan(TOOLBAR_CONTROL_SIZES.pointer);
    // A disc's solid glyph stays at the `md` size so the stop square does not fill its disc.
    expect(TOOLBAR_DISC_GLYPH_SIZES).toEqual({ touch: 20, pointer: 16 });
  });

  it("keeps a touch glyph beside a label at the label's 20pt scale", () => {
    expect(toolbarGlyphsFor("touch").label).toEqual({
      size: 20,
      strokeWidth: 1.5,
      tone: "foreground",
    });
    expect(TOOLBAR_GLYPH_SIZES.label).toEqual({ xs: 20, md: 16 });
  });

  it("sizes the touch context ring to the toolbar glyph's ink and keeps the pointer ring", () => {
    expect(TOOLBAR_RINGS).toEqual({
      touch: { size: 18, strokeWidth: 2 },
      pointer: { size: 16, strokeWidth: 2 },
    });
  });

  it("brightens a muted toolbar glyph under a hovering pointer", () => {
    const pointer = toolbarGlyphsFor("pointer").icon;
    const touch = toolbarGlyphsFor("touch").icon;
    expect(toolbarGlyphTone(pointer, false)).toBe("muted");
    expect(toolbarGlyphTone(pointer, true)).toBe("foreground");
    expect(toolbarGlyphTone(touch, false)).toBe("foreground");
    const colors = { foreground: "#fafafa", foregroundMuted: "#a1a5a4" };
    const palette = { colors } as unknown as Theme;
    expect(toolbarGlyphColor(palette, "foreground")).toBe("#fafafa");
    expect(toolbarGlyphColor(palette, "muted")).toBe("#a1a5a4");
  });
});

describe("control geometry", () => {
  it("keeps resting control borders transparent while preserving border geometry", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.controlRest).toMatchObject({
      borderWidth: 1,
      borderColor: "transparent",
      outlineColor: "transparent",
      outlineWidth: 0,
    });
  });

  it("uses the shared hover border and active focus ring values", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.controlHover).toEqual({
      borderColor: "#2F3534",
    });
    expect(geometry.controlActive).toEqual({
      borderColor: "#2F3534",
      outlineColor: "#20744A",
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    });
  });

  it("resolves disabled, focus, open, pressed, and hover into one interaction phase", () => {
    expect(getControlInteractionPhase({ disabled: true, focused: true })).toBe("rest");
    expect(getControlInteractionPhase({ focused: true })).toBe("active");
    expect(getControlInteractionPhase({ open: true })).toBe("active");
    expect(getControlInteractionPhase({ pressed: true })).toBe("active");
    expect(getControlInteractionPhase({ hovered: true })).toBe("hover");
    expect(getControlInteractionPhase({})).toBe("rest");
  });

  it("keeps field text sizing tied to control size", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.fieldTextSm.fontSize).toBe(12);
    expect(geometry.fieldTextSm.lineHeight).toBe(17);
    expect(geometry.fieldTextMd.fontSize).toBe(14);
    expect(geometry.fieldTextMd.lineHeight).toBe(20);
    expect(geometry.formTextInputSm.fontSize).toBe(12);
    expect(geometry.formTextInputMd.fontSize).toBe(14);
  });

  it("derives field padding from content and border without changing the control height", () => {
    const geometry = createControlGeometry(theme);
    const borderWidth = theme.borderWidth[1];

    expect(geometry.fieldControlSm.minHeight).toEqual({ xs: 32, md: 28 });
    // The default keeps a 44 touch target in the compact layout and is 32 from the md
    // breakpoint up.
    expect(geometry.fieldControlMd.minHeight).toEqual({ xs: 44, md: 32 });
    expect(geometry.fieldControlMd.paddingVertical).toEqual({ xs: 11, md: 5 });
    for (const layout of ["xs", "md"] as const) {
      expect(
        geometry.fieldTextSm.lineHeight +
          geometry.fieldControlSm.paddingVertical[layout] * 2 +
          borderWidth * 2,
      ).toBe(geometry.fieldControlSm.minHeight[layout]);
      expect(
        geometry.fieldTextMd.lineHeight +
          geometry.fieldControlMd.paddingVertical[layout] * 2 +
          borderWidth * 2,
      ).toBe(geometry.fieldControlMd.minHeight[layout]);
    }
  });

  it("keeps segmented controls ghost with button-radius segments in a button-sized track", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.segmentedContainerSm.padding).toBe(0);
    expect(geometry.segmentedContainerMd.padding).toBe(0);
    expect(geometry.segmentedSegmentSm.borderRadius).toBe(geometry.buttonSm.borderRadius);
    expect(geometry.segmentedSegmentMd.borderRadius).toBe(geometry.buttonMd.borderRadius);
    expect(geometry.segmentedContainerSm.minHeight).toEqual(geometry.buttonSm.minHeight);
    expect(geometry.segmentedContainerMd.minHeight).toEqual(geometry.buttonMd.minHeight);
    expect(geometry.segmentedSegmentSm.minHeight).toEqual({ xs: 28, md: 24 });
    expect(geometry.segmentedSegmentMd.minHeight).toEqual({ xs: 40, md: 28 });
  });

  it("keeps one size contract across buttons, fields, and segmented controls", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.buttonSm.minHeight).toEqual({ xs: 32, md: 28 });
    expect(geometry.buttonMd.minHeight).toEqual({ xs: 44, md: 32 });
    expect(geometry.buttonSm.minHeight).toEqual(CONTROL_HEIGHTS.sm);
    expect(geometry.buttonMd.minHeight).toEqual(CONTROL_HEIGHTS.md);
    expect(geometry.fieldControlSm.minHeight).toEqual(CONTROL_HEIGHTS.sm);
    expect(geometry.fieldControlMd.minHeight).toEqual(CONTROL_HEIGHTS.md);
    expect(controlHeightForLayout("md", true)).toBe(44);
    expect(controlHeightForLayout("md", false)).toBe(32);
    expect(controlHeightForLayout("sm", true)).toBe(32);
    expect(controlHeightForLayout("sm", false)).toBe(28);

    // Same size name means the same label size on every control kind.
    expect(geometry.segmentedLabelSm.fontSize).toBe(12);
    expect(geometry.segmentedLabelSm.fontSize).toBe(geometry.buttonTextSm.fontSize);
    expect(geometry.segmentedLabelMd.fontSize).toBe(14);
    expect(geometry.segmentedLabelMd.fontSize).toBe(geometry.buttonTextMd.fontSize);

    // Segments sit inside a track, so they run tighter than a standalone button of the same
    // size — the gap between segments reads as the padding.
    expect(geometry.segmentedSegmentSm.paddingHorizontal).toBeLessThan(
      geometry.buttonSm.paddingHorizontal,
    );
    for (const layout of ["xs", "md"] as const) {
      expect(geometry.segmentedSegmentMd.paddingHorizontal).toBeLessThan(
        geometry.buttonMd.paddingHorizontal[layout],
      );
    }
  });

  it("sizes switches with the same two control sizes", () => {
    expect(switchGeometryForLayout("md", false)).toEqual({
      trackWidth: 34,
      trackHeight: 20,
      thumbSize: 16,
      thumbTravel: 14,
      reservedHeight: 32,
    });
    expect(switchGeometryForLayout("md", true)).toEqual({
      trackWidth: 44,
      trackHeight: 26,
      thumbSize: 22,
      thumbTravel: 18,
      reservedHeight: 44,
    });
    // Tight chrome keeps the pointer-sized track on every layout and reserves its row's height.
    expect(switchGeometryForLayout("sm", true)).toMatchObject({
      trackWidth: 34,
      reservedHeight: 32,
    });
    expect(switchGeometryForLayout("sm", false)).toMatchObject({
      trackWidth: 34,
      reservedHeight: 28,
    });
  });

  it("gives alert title and description one font size and a tight gap per size", () => {
    const { alert } = createControlGeometry(theme);

    expect(alert.xs.text).toEqual({ fontSize: 12 });
    expect(alert.sm.text).toEqual({ fontSize: 14 });
    expect(alert.md.text).toEqual(alert.sm.text);
    expect(alert.lg.text).toEqual(alert.sm.text);
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(alert[size].container.gap).toBeLessThanOrEqual(4);
    }
  });

  it("starts alert text below the lead row at the lead text's left edge", () => {
    const { alert } = createControlGeometry(theme);

    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(alert[size].iconSlot.width).toBe(ALERT_ICON_SIZE[size]);
      expect(alert[size].indent.marginLeft).toBe(alert[size].iconSlot.width + alert[size].lead.gap);
    }
  });

  it("keeps sm alerts as roomy and round as the original alert, and scales the rest around it", () => {
    const { alert } = createControlGeometry(theme);

    expect(alert.sm.container).toMatchObject({
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 16,
    });
    expect(alert.xs.container.paddingVertical).toBeLessThan(alert.sm.container.paddingVertical);
    expect(alert.md.container.paddingVertical).toBeGreaterThan(alert.sm.container.paddingVertical);
    expect(alert.lg.container.paddingVertical).toBeGreaterThan(alert.md.container.paddingVertical);
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(alert[size].container.borderRadius).toBeGreaterThanOrEqual(12);
    }
  });
});
