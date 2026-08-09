import type { ReactNode } from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_RING_FRAME_SIZE,
  STATUS_RING_HEAD_OPACITY,
  STATUS_RING_SIZE,
  STATUS_RING_STROKE,
  STATUS_RING_TRACK_OPACITY,
} from "@/components/status-ring/geometry";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

export interface StatusRingProps {
  // The surface the ring is drawn on top of, named rather than resolved, because theme colours
  // are only legible inside `StyleSheet.create` — see docs/unistyles.md. The frame fills itself
  // with this so the ring reads as a hole punched in whatever it overlaps: the agent icon under a
  // tab dot, the project tile under a sidebar badge. Leave it out where the ring sits on flat
  // background and has nothing to knock out.
  backdrop?: SurfaceBackdrop | null;
}

/**
 * The static half of the running indicator: the knockout, the track, and the centre dot. The
 * platform entry points supply the rotating quarter and own only how it is driven.
 *
 * The ring has no colour prop. It only ever means one thing — an agent is running — so it reads
 * that one colour out of the theme itself. Passing the colour in would materialise it at the call
 * site, outside anything Unistyles tracks, and leave the mark in the old theme until something
 * incidental re-rendered the row.
 */
export function StatusRingFrame({ backdrop, children }: StatusRingProps & { children: ReactNode }) {
  return (
    <View style={[styles.frame, getBackdropStyle(backdrop)]}>
      <View style={styles.track} />
      {children}
      <View style={styles.centerDot} />
    </View>
  );
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
    case "surface2":
      return styles.backdropSurface2;
    default:
      return null;
  }
}

// The rotating quarter's geometry, deliberately plain React Native rather than Unistyles: on
// native this style lands on a Reanimated `Animated.View`, and applying a theme-tracked style to
// one crashes when the theme changes — Unistyles and Reanimated both mutate the same native node.
// See docs/unistyles.md. The colour it needs lives on `styles.arc`, one level in, on a view
// Reanimated never touches.
export const rotatorStyles = RNStyleSheet.create({
  rotator: {
    position: "absolute",
    width: STATUS_RING_SIZE,
    height: STATUS_RING_SIZE,
  },
});

export const styles = StyleSheet.create((theme) => {
  const circle = {
    width: STATUS_RING_SIZE,
    height: STATUS_RING_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: STATUS_RING_STROKE,
  } as const;
  const runningColor = getStatusDotColor({ theme, bucket: "running" }) ?? undefined;

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
    backdropSurface2: { backgroundColor: theme.colors.surface2 },

    // The closed ring the quarter runs on. Same colour rather than a grey so the indicator is one
    // object at one hue; the opacity is what puts it behind the quarter instead of competing.
    track: {
      ...circle,
      position: "absolute",
      borderColor: runningColor,
      opacity: STATUS_RING_TRACK_OPACITY,
    },

    // The moving quarter. Three sides transparent leaves the top border alone, which on a fully
    // rounded box is a 90° arc — the edge that makes the rotation legible against the track.
    arc: {
      ...circle,
      borderColor: "transparent",
      borderTopColor: runningColor,
      opacity: STATUS_RING_HEAD_OPACITY,
    },

    centerDot: {
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: runningColor,
    },
  };
});
