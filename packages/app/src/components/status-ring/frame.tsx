import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_RING_FRAME_SIZE,
  STATUS_RING_HEAD_OPACITY,
  STATUS_RING_SIZE,
  STATUS_RING_STROKE,
  STATUS_RING_TRACK_OPACITY,
} from "@/components/status-ring/geometry";
import { StatusRingRotator } from "@/components/status-ring/motion";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

export interface StatusRingProps {
  // The surface the ring is drawn on top of, named rather than resolved, because theme colours
  // are only legible inside `StyleSheet.create` — see docs/unistyles.md. The frame fills itself
  // with this so the ring reads as a hole punched in whatever it overlaps: the agent icon under a
  // tab dot, the project tile under a sidebar badge. Leave it out where the ring sits on flat
  // background and has nothing to knock out.
  backdrop?: SurfaceBackdrop | null;
}

// The two colours a running mark breathes between: its own, and the success green it would settle
// into as a finished agent. Named rather than passed in, for the reason the ring has no colour
// prop: a colour materialised at the call site sits outside anything Unistyles tracks and leaves
// the mark in the old theme until something incidental re-renders the row.
export type StatusRingTone = "running" | "success";

const STATUS_RING_TONE_BUCKETS = {
  running: "running",
  success: "attention",
} as const;

export function getStatusRingToneColor(theme: Theme, tone: StatusRingTone): string | undefined {
  return getStatusDotColor({ theme, bucket: STATUS_RING_TONE_BUCKETS[tone] }) ?? undefined;
}

/** The knockout the running mark sits in. */
export function StatusRingFrame({ backdrop, children }: StatusRingProps & { children: ReactNode }) {
  return <View style={[styles.frame, getBackdropStyle(backdrop)]}>{children}</View>;
}

/**
 * The mark itself, in one tone: the track, the rotating quarter, and the centre dot. The ring
 * draws it twice, running under success, and the motion layer fades the success copy in and out.
 */
export function StatusRingInk({ tone }: { tone: StatusRingTone }) {
  const ink = getInkStyles(tone);
  return (
    <>
      <View style={ink.track} />
      <StatusRingRotator>
        <View style={ink.arc} />
      </StatusRingRotator>
      <View style={ink.centerDot} />
    </>
  );
}

function getInkStyles(tone: StatusRingTone) {
  if (tone === "success") {
    return {
      track: styles.trackSuccess,
      arc: styles.arcSuccess,
      centerDot: styles.centerDotSuccess,
    };
  }
  return {
    track: styles.trackRunning,
    arc: styles.arcRunning,
    centerDot: styles.centerDotRunning,
  };
}

function getBackdropStyle(backdrop: SurfaceBackdrop | null | undefined) {
  switch (backdrop) {
    case "surface0":
      return styles.backdropSurface0;
    case "surface1":
      return styles.backdropSurface1;
    case "surfaceSidebar":
      return styles.backdropSurfaceSidebar;
    case "surfaceSidebarHover":
      return styles.backdropSurfaceSidebarHover;
    case "surfaceSidebarSelected":
      return styles.backdropSurfaceSidebarSelected;
    case "surface2":
      return styles.backdropSurface2;
    default:
      return null;
  }
}

const styles = StyleSheet.create((theme) => {
  const circle = {
    width: STATUS_RING_SIZE,
    height: STATUS_RING_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: STATUS_RING_STROKE,
  } as const;

  // Arrow expressions, not functions with a `return`: the Unistyles Babel plugin reads the first
  // `return { … }` in this factory as the stylesheet. Each coloured key below also names `theme`
  // itself, because the plugin only marks a key theme-dependent when its own value references it.
  // A colour hoisted into a variable drops that key out of native theme updates.

  // The closed ring the quarter runs on. Same colour rather than a grey so the indicator is one
  // object at one hue; the opacity is what puts it behind the quarter instead of competing.
  const track = (color: string | undefined) =>
    ({
      ...circle,
      position: "absolute",
      borderColor: color,
      opacity: STATUS_RING_TRACK_OPACITY,
    }) as const;

  // The moving quarter. Three sides transparent leaves the top border alone, which on a fully
  // rounded box is a 90° arc — the edge that makes the rotation legible against the track.
  const arc = (color: string | undefined) =>
    ({
      ...circle,
      borderColor: "transparent",
      borderTopColor: color,
      opacity: STATUS_RING_HEAD_OPACITY,
    }) as const;

  const centerDot = (color: string | undefined) =>
    ({
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: color,
    }) as const;

  return {
    frame: {
      width: STATUS_RING_FRAME_SIZE,
      height: STATUS_RING_FRAME_SIZE,
      borderRadius: theme.borderRadius.full,
      alignItems: "center",
      justifyContent: "center",
    },
    backdropSurface0: { backgroundColor: theme.colors.surface0 },
    backdropSurface1: { backgroundColor: theme.colors.surface1 },
    backdropSurfaceSidebar: { backgroundColor: theme.colors.surfaceSidebar },
    backdropSurfaceSidebarHover: { backgroundColor: theme.colors.surfaceSidebarHover },
    backdropSurfaceSidebarSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
    backdropSurface2: { backgroundColor: theme.colors.surface2 },

    trackRunning: track(getStatusRingToneColor(theme, "running")),
    trackSuccess: track(getStatusRingToneColor(theme, "success")),
    arcRunning: arc(getStatusRingToneColor(theme, "running")),
    arcSuccess: arc(getStatusRingToneColor(theme, "success")),
    centerDotRunning: centerDot(getStatusRingToneColor(theme, "running")),
    centerDotSuccess: centerDot(getStatusRingToneColor(theme, "success")),
  };
});
