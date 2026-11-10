import { hasTouchScreen } from "@/hooks/pointer-capabilities";

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
  /** The device has a touch screen; see `hasTouchScreen`. */
  touchScreen: boolean;
}

/**
 * The one sizing gate: touch-sized in the compact layout or on any device with a touch screen,
 * pointer-sized otherwise. A touch screen keeps touch sizing when a mouse or keyboard is attached.
 */
export function resolveControlSizing({
  compactLayout,
  touchScreen,
}: ControlSizingFacts): ControlSizing {
  if (compactLayout || touchScreen) return "touch";
  return "pointer";
}

// Read once, so attaching a mouse or keyboard later never flips the sizing.
const DEVICE_HAS_TOUCH_SCREEN = hasTouchScreen();

/** The sizing on this device for a layout, for code that sizes outside a stylesheet. */
export function controlSizingForLayout(compactLayout: boolean): ControlSizing {
  return resolveControlSizing({ compactLayout, touchScreen: DEVICE_HAS_TOUCH_SCREEN });
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
  touchScreen: boolean = DEVICE_HAS_TOUCH_SCREEN,
): LayoutValue {
  return {
    xs: sizes[resolveControlSizing({ compactLayout: true, touchScreen })],
    md: sizes[resolveControlSizing({ compactLayout: false, touchScreen })],
  };
}

/** Derives a breakpoint value from another, such as a row as tall as its control plus padding. */
export function mapLayout(value: LayoutValue, map: (height: number) => number): LayoutValue {
  return { xs: map(value.xs), md: map(value.md) };
}

/** The smallest touch target, and the size of every touch-sized icon button, row, and bar. */
export const TOUCH_TARGET = 44;
