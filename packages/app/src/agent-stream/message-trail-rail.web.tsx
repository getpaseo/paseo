import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MessageTrailItem } from "./message-trail-items";
import type { TrailAnchorSnapshot, TrailAnchorStore } from "./message-trail-anchor";
import {
  anchorOpacityFor,
  gaussianWeight,
  MAGNIFY_ACTIVATION,
  OPACITY_FOCUS,
  OPACITY_REST,
  RAIL_EDGE_MIN,
  RAIL_WIDTH,
  railFits,
  resolveNearestTickIndex,
  resolveRailLeft,
  resolveTickSpacing,
  TICK_HEIGHT,
  TICK_MAX_WIDTH,
  twoSigmaSqFor,
} from "./message-trail-rail-geometry";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export interface MessageTrailRailProps {
  items: MessageTrailItem[];
  anchor: TrailAnchorStore;
  onJumpToMessage: (id: string) => void;
  /**
   * Reports whether the rail's own live measurement says it currently has room to render
   * without overlapping the chat content. The caller uses this to decide whether to show
   * the floating table-of-contents instead — see message-trail-toc.web.tsx and the
   * `showMessageTrailToc` derivation in view.tsx.
   */
  onFitChange: (fits: boolean) => void;
}

// Geometry (px). Ticks are center-anchored and grow symmetrically on hover; the tick
// column is centered in the left gutter (see resolveRailLeft), so the rail fits in a
// narrower gutter than a left/right-anchored one would. Kept as small as still-usable
// (the click hit area is the whole rail region, not just the visible tick) — every pixel
// trimmed here lowers how much space is needed before the rail can show at all.
//
// These are plain literals rather than theme tokens: they feed raw DOM style/geometry math
// (imperative writes, CSS px), not a React `style` prop, which is exactly the case
// docs/unistyles.md's "hard-coded constants for genuinely static values" calls out — the
// values don't need to be theme-reactive, they need to be numbers JS can do arithmetic on.
// What *is* relative here is the geometry itself: rather than assuming a gutter width from
// a hardcoded content-width formula (which only ever exists past a large fixed pane width,
// regardless of device), every measurement below reads the real rendered DOM — the actual
// left edge of a chat message and the pane's actual height — so the rail adapts to whatever
// padding/breakpoint/font-scale is really in effect on this device, and can fit into a much
// smaller pane than a formula tied to the reading column's own fixed max-width ever could.
const TICK_HEIGHT_HOVER = 4; // hovered tick reads thicker, not just longer
const TICK_BASE_WIDTH = 6;
const REDUCED_MOTION_HOVER_WIDTH = 16;
const RAIL_HEIGHT_FRACTION = 0.8; // tick column capped at 80% of rail height
// Minimum breathing room between the rail's right edge (where a fully-magnified, center-
// anchored tick reaches — it can grow up to TICK_MAX_WIDTH === RAIL_WIDTH) and the content's
// real left edge. Mirrors the geometry module's constant so HIT_PADDING_RIGHT matches it.
const MIN_GAP_TO_CONTENT = 6;
// Push the tooltip up so it reads centered on the focused tick rather than starting below it.
const TOOLTIP_VERTICAL_NUDGE = 18;
const TOOLTIP_BOTTOM_CLEARANCE = 64;

// How much wider/taller the actual pointer hit-test region is than the visible tick column.
// Thin ticks over a short column are hard to target — this keeps the visible geometry small
// (still needed to fit a narrow gutter) while giving the pointer a somewhat larger, invisible
// area to land in. Purely an interaction affordance: nothing is painted in the extra space,
// and it only ever extends into the gutter's own dead space, never past the content's real
// left edge (right-side padding matches MIN_GAP_TO_CONTENT exactly).
//
// Deliberately modest, not "as much room as the pane allows": a hit area that reaches far
// past the actual ticks makes the tooltip (and magnification) trigger from way above/below
// the rail, which reads as broken rather than generous. The vertical buffer hugs the real
// tick column (via padding, so it always matches content — 2 ticks or 200) rather than a
// fraction of the pane's height.
const HIT_PADDING_LEFT = 16;
const HIT_PADDING_RIGHT = MIN_GAP_TO_CONTENT;
const HIT_PADDING_VERTICAL = 14;

// Static rail-region layout for the raw DOM host (left edge, vertically centered, ticks
// grow rightward). Column height is dynamic and lives on the inner div's memoized style.
//
// This div is the actual pointer/click target, and is deliberately WIDER than the visible
// tick column it centers (via negative left/right insets) and taller by a fixed padding
// (rather than a shrink-to-fit-only box) — see HIT_PADDING_* above. Nearest-neighbour
// magnification handles the resulting out-of-range pointerY/X gracefully (it just picks the
// nearest edge tick), so no separate clamping is needed for the enlarged area to work; the
// `maxHeight` stays as a safety clip for the rare case of hundreds of compressed ticks.
const RAIL_DIV_STYLE: CSSProperties = {
  position: "absolute",
  left: -HIT_PADDING_LEFT,
  right: -HIT_PADDING_RIGHT,
  top: "50%",
  transform: "translateY(-50%)",
  paddingTop: HIT_PADDING_VERTICAL,
  paddingBottom: HIT_PADDING_VERTICAL,
  maxHeight: `${RAIL_HEIGHT_FRACTION * 100}%`,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  overflowY: "hidden",
  cursor: "pointer",
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MessageTrailRail({
  items,
  anchor,
  onJumpToMessage,
  onFitChange,
}: MessageTrailRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  // Per-tick DOM nodes, indexed parallel to `items`. Written imperatively; never React state.
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastSnapshotRef = useRef<TrailAnchorSnapshot>(anchor.getSnapshot());
  const reducedMotionRef = useRef(prefersReducedMotion());

  // Roving tabstop + tooltip target. Focus index also drives the tooltip position/content.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [rovingIndex, setRovingIndex] = useState(0);
  // Real, self-measured geometry — never assumed from a formula. `contentInsetLeft` is the
  // actual left edge of a rendered chat message relative to the pane, and `paneHeight` is
  // the pane's own measured height. Self-contained via ResizeObserver so pane resizes never
  // re-render the (heavy) stream view.
  const [metrics, setMetrics] = useState<{ contentInsetLeft: number; paneHeight: number }>({
    contentInsetLeft: 0,
    paneHeight: 0,
  });

  const count = items.length;
  // Compress ticks to fit the available rail height when there are many messages.
  const availableHeight = metrics.paneHeight > 0 ? metrics.paneHeight * RAIL_HEIGHT_FRACTION : 0;
  const spacing = resolveTickSpacing(count, availableHeight);
  // Latest spacing for imperative pointer callbacks (magnification, click) without re-binding.
  const spacingRef = useRef(spacing);
  spacingRef.current = spacing;
  const columnHeight = Math.max(0, (count - 1) * spacing + TICK_HEIGHT);

  // Keep the refs array length in sync with items without reallocating on every render.
  if (tickRefs.current.length !== count) {
    tickRefs.current.length = count;
  }
  // Clamp roving index if the item set shrinks.
  if (rovingIndex >= count && count > 0) {
    // setState during render is allowed by React when it bails out to a re-render;
    // guard so we only do it when actually out of range.
    setRovingIndex(count - 1);
  }

  // Latest items available to imperative callbacks without re-subscribing.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Reset a single tick to its anchor-derived resting appearance.
  const resetTickStyle = useCallback((index: number, snapshot: TrailAnchorSnapshot) => {
    const node = tickRefs.current[index];
    const item = itemsRef.current[index];
    if (!node || !item) {
      return;
    }
    node.style.width = `${TICK_BASE_WIDTH}px`;
    node.style.height = `${TICK_HEIGHT}px`;
    node.style.opacity = String(anchorOpacityFor(item.id, snapshot));
  }, []);

  // Reset every tick to resting geometry/opacity (used on pointerleave and item changes).
  const resetAllTicks = useCallback(() => {
    const snapshot = lastSnapshotRef.current;
    for (let index = 0; index < itemsRef.current.length; index += 1) {
      resetTickStyle(index, snapshot);
    }
  }, [resetTickStyle]);

  // Apply Gaussian magnification centered on pointer Y (relative to the tick column).
  const applyMagnification = useCallback((pointerY: number) => {
    const snapshot = lastSnapshotRef.current;
    const list = itemsRef.current;
    const reducedMotion = reducedMotionRef.current;
    const tickSpacing = spacingRef.current;
    const twoSigmaSq = twoSigmaSqFor(tickSpacing);
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < list.length; index += 1) {
      const node = tickRefs.current[index];
      if (!node) {
        continue;
      }
      const center = index * tickSpacing + TICK_HEIGHT / 2;
      const distance = Math.abs(pointerY - center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }

      const item = list[index];
      const baseOpacity = item ? anchorOpacityFor(item.id, snapshot) : OPACITY_REST;

      if (reducedMotion) {
        // No morphing: snap only the nearest-ish tick to a modest fixed width, keep opacity.
        const isNear = distance <= tickSpacing / 2;
        node.style.width = isNear ? `${REDUCED_MOTION_HOVER_WIDTH}px` : `${TICK_BASE_WIDTH}px`;
        node.style.height = isNear ? `${TICK_HEIGHT_HOVER}px` : `${TICK_HEIGHT}px`;
        node.style.opacity = String(Math.max(baseOpacity, isNear ? OPACITY_FOCUS : baseOpacity));
        continue;
      }

      const weight = gaussianWeight(distance, twoSigmaSq);
      if (weight < MAGNIFY_ACTIVATION) {
        // Outside the tight focus window: rest geometry, anchor opacity.
        node.style.width = `${TICK_BASE_WIDTH}px`;
        node.style.height = `${TICK_HEIGHT}px`;
        node.style.opacity = String(baseOpacity);
        continue;
      }
      node.style.width = `${TICK_BASE_WIDTH + (TICK_MAX_WIDTH - TICK_BASE_WIDTH) * weight}px`;
      node.style.height = `${TICK_HEIGHT + (TICK_HEIGHT_HOVER - TICK_HEIGHT) * weight}px`;
      node.style.opacity = String(
        Math.min(OPACITY_FOCUS, baseOpacity + (OPACITY_FOCUS - baseOpacity) * weight),
      );
    }

    return nearestIndex;
  }, []);

  // Single coalesced pointermove -> one rAF -> imperative writes. Zero React state per frame.
  const pendingPointerYRef = useRef<number | null>(null);
  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }
      const column = columnRef.current;
      if (!column) {
        return;
      }
      const rect = column.getBoundingClientRect();
      pendingPointerYRef.current = event.clientY - rect.top;
      if (rafRef.current !== null) {
        return;
      }
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const pointerY = pendingPointerYRef.current;
        if (pointerY === null) {
          return;
        }
        const nearest = applyMagnification(pointerY);
        if (nearest >= 0) {
          setFocusIndex(nearest);
        }
      });
    },
    [applyMagnification],
  );

  const handlePointerLeave = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingPointerYRef.current = null;
    resetAllTicks();
    setFocusIndex(null);
  }, [resetAllTicks]);

  // Bind pointer listeners on the rail container (covers ticks + spacing hit area).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    rail.addEventListener("pointermove", handlePointerMove);
    rail.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      rail.removeEventListener("pointermove", handlePointerMove);
      rail.removeEventListener("pointerleave", handlePointerLeave);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [handlePointerMove, handlePointerLeave]);

  // Measure the pane (the rail's grandparent container) so the rail can sit against the
  // real content edge and the tooltip can track the vertically-centered ticks.
  // Self-contained via ResizeObserver so pane resizes never re-render AgentStreamView.
  const measureRef = useRef<() => void>(() => {});
  useEffect(() => {
    const container = railRef.current?.parentElement?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      const height = container.clientHeight;
      // The real left edge of a rendered chat message, relative to the pane — this is what
      // actually determines whether the rail has room, on this device, at this font scale,
      // under this breakpoint's padding, rather than an assumed formula.
      const itemEl = container.querySelector<HTMLElement>('[id^="stream-item-"]');
      const measuredInset = itemEl
        ? Math.max(0, itemEl.getBoundingClientRect().left - containerRect.left)
        : null;
      setMetrics((prev) => {
        // No stream item mounted yet (e.g. the very first frame): keep the last known inset
        // rather than snapping to 0, which would spuriously report "doesn't fit".
        const nextInset = measuredInset === null ? prev.contentInsetLeft : measuredInset;
        if (prev.paneHeight === height && prev.contentInsetLeft === nextInset) {
          return prev;
        }
        return { contentInsetLeft: nextInset, paneHeight: height };
      });
    };
    measureRef.current = measure;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // The container's own size doesn't change just because a new message mounted, so the
  // ResizeObserver above won't refire for that — re-measure whenever the item set changes so
  // the very first message's real inset is picked up as soon as it exists.
  useEffect(() => {
    measureRef.current();
  }, [items]);

  const fits = railFits(metrics.contentInsetLeft, metrics.paneHeight);
  const lastReportedFitRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastReportedFitRef.current === fits) {
      return;
    }
    lastReportedFitRef.current = fits;
    onFitChange(fits);
  }, [fits, onFitChange]);

  // Subscribe to the anchor store and write opacity changes to only the affected ticks.
  useEffect(() => {
    const applySnapshot = (next: TrailAnchorSnapshot) => {
      const prev = lastSnapshotRef.current;
      lastSnapshotRef.current = next;
      // While the pointer is actively hovering (e.g. right after a click-triggered scroll
      // updates which tick is "current"), re-run magnification immediately against the last
      // known pointer position and the fresh snapshot, instead of writing nothing and
      // waiting for the next mouse move — otherwise the tick styles go stale until the
      // pointer physically moves again, which reads as "no animation happened".
      const pointerY = pendingPointerYRef.current;
      if (pointerY !== null) {
        applyMagnification(pointerY);
        return;
      }
      // Only touch ticks whose base opacity actually changed between snapshots.
      for (let index = 0; index < itemsRef.current.length; index += 1) {
        const item = itemsRef.current[index];
        const node = tickRefs.current[index];
        if (!item || !node) {
          continue;
        }
        const before = anchorOpacityFor(item.id, prev);
        const after = anchorOpacityFor(item.id, next);
        if (before !== after) {
          node.style.opacity = String(after);
        }
      }
    };
    // Seed against the current snapshot in case it advanced before subscribe.
    applySnapshot(anchor.getSnapshot());
    return anchor.subscribe(applySnapshot);
  }, [anchor, applyMagnification]);

  // On mount and whenever the item set changes, paint resting styles.
  useLayoutEffect(() => {
    resetAllTicks();
  }, [resetAllTicks, count]);

  const activateIndex = useCallback(
    (index: number) => {
      const item = itemsRef.current[index];
      if (item) {
        onJumpToMessage(item.id);
      }
    },
    [onJumpToMessage],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const next = Math.min(count - 1, index + 1);
          setRovingIndex(next);
          tickRefs.current[next]?.focus();
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const next = Math.max(0, index - 1);
          setRovingIndex(next);
          tickRefs.current[next]?.focus();
          break;
        }
        case "Home": {
          event.preventDefault();
          setRovingIndex(0);
          tickRefs.current[0]?.focus();
          break;
        }
        case "End": {
          event.preventDefault();
          const last = count - 1;
          setRovingIndex(last);
          tickRefs.current[last]?.focus();
          break;
        }
        case "Enter":
        case " ": {
          event.preventDefault();
          activateIndex(index);
          break;
        }
        case "Escape": {
          event.preventDefault();
          tickRefs.current[index]?.blur();
          break;
        }
        default:
          break;
      }
    },
    [activateIndex, count],
  );

  const handleTickFocus = useCallback((index: number) => {
    setFocusIndex(index);
    setRovingIndex(index);
  }, []);

  const handleTickBlur = useCallback(() => {
    setFocusIndex(null);
  }, []);

  // Stable ref registrar so each memoized tick can publish its DOM node by index without
  // an inline ref callback (which would defeat memoization and trip react-perf lint).
  const registerTickRef = useCallback((index: number, node: HTMLButtonElement | null) => {
    tickRefs.current[index] = node;
  }, []);

  // Whole-rail click: map pointer Y to nearest tick and jump.
  const handleRailClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const column = columnRef.current;
      if (!column || itemsRef.current.length === 0) {
        return;
      }
      const rect = column.getBoundingClientRect();
      const pointerY = event.clientY - rect.top;
      const nearestIndex = resolveNearestTickIndex(
        pointerY,
        itemsRef.current.length,
        spacingRef.current,
      );
      activateIndex(nearestIndex);
    },
    [activateIndex],
  );

  const focusedItem = fits && focusIndex !== null ? items[focusIndex] : null;
  const reducedMotion = reducedMotionRef.current;

  // The tick column is vertically centered in the pane-height rail, so the tooltip must be
  // placed against the column's real top, not the pane top (the old bug that floated it up).
  const columnTop =
    metrics.paneHeight > 0 ? Math.max(0, (metrics.paneHeight - columnHeight) / 2) : 0;
  const tooltipTop = useMemo(() => {
    if (focusIndex === null) {
      return 0;
    }
    const tickCenter = columnTop + focusIndex * spacing + TICK_HEIGHT / 2;
    const maxTop =
      metrics.paneHeight > 0
        ? Math.max(RAIL_EDGE_MIN, metrics.paneHeight - TOOLTIP_BOTTOM_CLEARANCE)
        : Number.POSITIVE_INFINITY;
    return Math.min(maxTop, Math.max(RAIL_EDGE_MIN, tickCenter - TOOLTIP_VERTICAL_NUDGE));
  }, [focusIndex, columnTop, metrics.paneHeight, spacing]);
  const tooltipStyle = useMemo(
    () => [styles.tooltip, inlineUnistylesStyle({ top: tooltipTop })],
    [tooltipTop],
  );

  // Sit the rail against the real content edge, ticks a fixed gap away from it. Irrelevant
  // (and never visible) while `!fits`, but still a cheap, safe computation either way.
  const railLeft = resolveRailLeft(metrics.contentInsetLeft);
  const railParentStyle = useMemo(
    () => [styles.railParent, inlineUnistylesStyle({ left: railLeft })],
    [railLeft],
  );
  const columnStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: TICK_MAX_WIDTH,
      height: columnHeight,
      flexShrink: 0,
    }),
    [columnHeight],
  );
  // When it doesn't fit, keep the measuring DOM node mounted (so a later resize can still
  // recover) but invisible and non-interactive — the floating TOC is the visible fallback.
  const railDivStyle = useMemo<CSSProperties>(
    () => (fits ? RAIL_DIV_STYLE : { ...RAIL_DIV_STYLE, opacity: 0, pointerEvents: "none" }),
    [fits],
  );

  return (
    <View style={railParentStyle} pointerEvents={fits ? "box-none" : "none"}>
      <div
        ref={railRef}
        style={railDivStyle}
        onClick={handleRailClick}
        role="tablist"
        aria-label="Message trail"
        aria-hidden={!fits}
      >
        <div ref={columnRef} style={columnStyle}>
          {fits &&
            items.map((item, index) => (
              <TrailTick
                key={item.id}
                index={index}
                item={item}
                spacing={spacing}
                isRoving={index === rovingIndex}
                reducedMotion={reducedMotion}
                registerRef={registerTickRef}
                onKeyDown={handleKeyDown}
                onFocus={handleTickFocus}
                onBlur={handleTickBlur}
              />
            ))}
        </div>
      </div>
      {focusedItem ? (
        <View style={tooltipStyle} pointerEvents="none">
          <Text style={styles.tooltipPreview} numberOfLines={2}>
            {focusedItem.preview}
          </Text>
          {focusedItem.responsePreview ? (
            <Text style={styles.tooltipResponse} numberOfLines={2}>
              {focusedItem.responsePreview}
            </Text>
          ) : null}
          {focusedItem.attachmentCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{focusedItem.attachmentCount}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface TrailTickProps {
  index: number;
  item: MessageTrailItem;
  spacing: number;
  isRoving: boolean;
  reducedMotion: boolean;
  registerRef: (index: number, node: HTMLButtonElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
  onFocus: (index: number) => void;
  onBlur: () => void;
}

// One tick. Memoized so a scroll-driven anchor change (which never re-renders the rail)
// and pointer magnification (imperative style writes) don't churn ticks. width/opacity
// are owned imperatively by the parent via the registered ref; this only paints resting
// geometry and wires keyboard/focus.
const TrailTick = memo(function TrailTick({
  index,
  item,
  spacing,
  isRoving,
  reducedMotion,
  registerRef,
  onKeyDown,
  onFocus,
  onBlur,
}: TrailTickProps) {
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => registerRef(index, node),
    [registerRef, index],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => onKeyDown(event, index),
    [onKeyDown, index],
  );
  const handleFocus = useCallback(() => onFocus(index), [onFocus, index]);
  const style = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      // Center-anchored: the tick sits at the column's horizontal center and grows
      // symmetrically as its width is written during magnification.
      left: "50%",
      top: index * spacing,
      transform: "translateX(-50%)",
      height: TICK_HEIGHT,
      width: TICK_BASE_WIDTH,
      padding: 0,
      border: "none",
      borderRadius: 1,
      // Themed via the Unistyles-maintained CSS variable (updates on theme change with no
      // React re-render and no per-frame JS color write). Only width/opacity are written
      // imperatively during magnification.
      backgroundColor: "var(--colors-foreground)",
      opacity: OPACITY_REST,
      cursor: "pointer",
      transitionProperty: reducedMotion ? "none" : "width, height, opacity",
      transitionDuration: reducedMotion ? "0ms" : "80ms",
    }),
    [index, spacing, reducedMotion],
  );
  return (
    <button
      type="button"
      ref={handleRef}
      tabIndex={isRoving ? 0 : -1}
      aria-label={item.preview || `Message ${item.ordinal}`}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={onBlur}
      style={style}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  railParent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: RAIL_WIDTH,
  },
  tooltip: {
    position: "absolute",
    left: RAIL_WIDTH + theme.spacing[2],
    // A real width range: without a floor the box collapses toward the narrow rail parent
    // and the text wraps to nothing.
    minWidth: 220,
    maxWidth: 340,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[1],
    ...theme.shadow.sm,
  },
  tooltipPreview: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  tooltipResponse: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  badge: {
    alignSelf: "flex-start",
    marginTop: theme.spacing[1],
    paddingVertical: 1,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
