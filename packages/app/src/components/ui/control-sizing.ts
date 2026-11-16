import { hasTouchPrimaryPointer } from "@/hooks/pointer-capabilities";

// The sizing gate, apart from the control sizes so that low-level modules such as
// `constants/layout` can size by it without loading the theme. Import it through
// `@/components/ui/control-geometry`, which re-exports it.

/**
 * Every size comes in a touch value and a pointer value. Touch values follow Apple's Human
 * Interface Guidelines for iOS and iPadOS: a 44pt default control and hit region, nothing
 * smaller than its 28pt minimum. Pointer values sit one step down the same button ladder.
 */
export type ControlSizing = "touch" | "pointer";

export interface ControlSizingFacts {
  /** The layout is below the `md` breakpoint. */
  compactLayout: boolean;
  /** Touch is the device's primary input; see `hasTouchPrimaryPointer`. */
  touchPrimaryPointer: boolean;
}

/**
 * The one sizing gate: touch-sized in the compact layout or where touch is the primary input,
 * pointer-sized otherwise. An iPad keeps touch sizing with a trackpad attached; a laptop with a
 * touch screen that its trackpad drives is pointer-sized.
 */
export function resolveControlSizing({
  compactLayout,
  touchPrimaryPointer,
}: ControlSizingFacts): ControlSizing {
  if (compactLayout || touchPrimaryPointer) return "touch";
  return "pointer";
}

// Read once, so attaching a mouse or keyboard later never flips the sizing.
const DEVICE_HAS_TOUCH_PRIMARY_POINTER = hasTouchPrimaryPointer();

/** The sizing on this device for a layout, for code that sizes outside a stylesheet. */
export function controlSizingForLayout(compactLayout: boolean): ControlSizing {
  return resolveControlSizing({
    compactLayout,
    touchPrimaryPointer: DEVICE_HAS_TOUCH_PRIMARY_POINTER,
  });
}

/** A Unistyles breakpoint value: one number in the compact layout, another from `md` up. */
// A mapped type, not an interface: Unistyles checks breakpoint objects against an index
// signature, which interfaces never satisfy.
export type LayoutValue = Record<"xs" | "md", number>;

export type SizingValue = Record<ControlSizing, number>;

/**
 * A size as a Unistyles breakpoint value. The compact layout always takes the touch value; from
 * `md` up the device decides.
 */
export function bySizing(
  sizes: SizingValue,
  touchPrimaryPointer: boolean = DEVICE_HAS_TOUCH_PRIMARY_POINTER,
): LayoutValue {
  return {
    xs: sizes[resolveControlSizing({ compactLayout: true, touchPrimaryPointer })],
    md: sizes[resolveControlSizing({ compactLayout: false, touchPrimaryPointer })],
  };
}

/** Derives a breakpoint value from another, such as a row as tall as its control plus padding. */
export function mapLayout(value: LayoutValue, map: (height: number) => number): LayoutValue {
  return { xs: map(value.xs), md: map(value.md) };
}

/** The smallest touch target, and the size of every touch-sized icon button, row, and bar. */
export const TOUCH_TARGET = 44;
