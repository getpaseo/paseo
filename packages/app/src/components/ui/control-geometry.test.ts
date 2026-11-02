import { describe, expect, it } from "vitest";
import {
  ALERT_ICON_SIZE,
  CONTROL_HEIGHTS,
  controlHeightForLayout,
  createControlGeometry,
  switchGeometryForLayout,
  getControlInteractionPhase,
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

    expect(geometry.fieldControlSm.minHeight).toBe(28);
    expect(
      geometry.fieldTextSm.lineHeight +
        geometry.fieldControlSm.paddingVertical * 2 +
        borderWidth * 2,
    ).toBe(geometry.fieldControlSm.minHeight);

    // The default keeps a 44 touch target in the compact layout and is 32 from the md
    // breakpoint up.
    expect(geometry.fieldControlMd.minHeight).toEqual({ xs: 44, md: 32 });
    expect(geometry.fieldControlMd.paddingVertical).toEqual({ xs: 11, md: 5 });
    for (const layout of ["xs", "md"] as const) {
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
    expect(geometry.segmentedContainerSm.minHeight).toBe(geometry.buttonSm.minHeight);
    expect(geometry.segmentedContainerMd.minHeight).toEqual(geometry.buttonMd.minHeight);
    expect(geometry.segmentedSegmentSm.minHeight).toBe(24);
    expect(geometry.segmentedSegmentMd.minHeight).toEqual({ xs: 40, md: 28 });
  });

  it("keeps one size contract across buttons, fields, and segmented controls", () => {
    const geometry = createControlGeometry(theme);

    expect(geometry.buttonSm.minHeight).toBe(28);
    expect(geometry.buttonMd.minHeight).toEqual({ xs: 44, md: 32 });
    expect(geometry.buttonSm.minHeight).toBe(CONTROL_HEIGHTS.sm);
    expect(geometry.buttonMd.minHeight).toEqual(CONTROL_HEIGHTS.md);
    expect(geometry.fieldControlSm.minHeight).toBe(CONTROL_HEIGHTS.sm);
    expect(geometry.fieldControlMd.minHeight).toEqual(CONTROL_HEIGHTS.md);
    expect(controlHeightForLayout("md", true)).toBe(44);
    expect(controlHeightForLayout("md", false)).toBe(32);
    expect(controlHeightForLayout("sm", true)).toBe(28);

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
    // Tight chrome keeps the pointer-sized switch on every layout.
    for (const isCompact of [true, false]) {
      expect(switchGeometryForLayout("sm", isCompact)).toMatchObject({
        trackWidth: 34,
        reservedHeight: 28,
      });
    }
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
