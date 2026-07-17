import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { TimelineSearchTarget } from "./search-target";

export interface TimelineSearchOccurrenceAnchor {
  key: string;
  /** Exact spans win over containing-block fallbacks for the same occurrence. */
  priority?: number;
  /** Measures the anchor in window coordinates, after layout has settled. */
  measure: (report: (centerY: number) => void) => void;
}

export interface TimelineSearchOccurrenceAnchorController {
  setTarget: (target: TimelineSearchTarget | null) => void;
  register: (anchor: TimelineSearchOccurrenceAnchor) => () => void;
  dispose: () => void;
}

export interface CreateTimelineSearchOccurrenceAnchorControllerInput {
  scrollBy: (deltaY: number) => void;
  getTargetCenterY: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

const CENTER_TOLERANCE = 24;

export function getTimelineSearchOccurrenceAnchorKey(
  target: Pick<TimelineSearchTarget, "itemId" | "field" | "matchOffset" | "matchLength">,
): string {
  return `${target.itemId}:${target.field}:${target.matchOffset}:${target.matchLength}`;
}

function getTargetRevisionKey(target: TimelineSearchTarget): string {
  return `${getTimelineSearchOccurrenceAnchorKey(target)}:${target.navigationRevision}`;
}

/**
 * Returns the outer viewport adjustment needed to center an active occurrence.
 * Small differences are ignored to avoid a distracting micro-scroll after the
 * virtualized row has already landed close enough to the centre.
 */
export function getTimelineSearchOccurrenceScrollDelta(
  anchorCenterY: number,
  targetCenterY: number,
): number {
  const deltaY = anchorCenterY - targetCenterY;
  return Math.abs(deltaY) <= CENTER_TOLERANCE ? 0 : deltaY;
}

/**
 * Keeps only the current occurrence eligible to scroll. The double frame lets
 * the outer virtualizer's scroll and an auto-expanded tool detail commit before
 * measuring the nested text anchor. Every callback is revision-checked, so a
 * stale measurement from a previous result cannot move the viewport.
 */
export function createTimelineSearchOccurrenceAnchorController(
  input: CreateTimelineSearchOccurrenceAnchorControllerInput,
): TimelineSearchOccurrenceAnchorController {
  const requestFrame = input.requestFrame ?? requestAnimationFrame;
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame;
  const anchors = new Map<string, Map<symbol, TimelineSearchOccurrenceAnchor>>();
  let target: TimelineSearchTarget | null = null;
  let frame: number | null = null;
  let centeredRevisionKey: string | null = null;

  const getAnchor = (key: string): TimelineSearchOccurrenceAnchor | undefined => {
    const anchorsForKey = anchors.get(key);
    if (!anchorsForKey) return undefined;
    let selected: TimelineSearchOccurrenceAnchor | undefined;
    for (const candidate of anchorsForKey.values()) {
      if (!selected || (candidate.priority ?? 0) > (selected.priority ?? 0)) {
        selected = candidate;
      }
    }
    return selected;
  };

  const cancelPendingFrame = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  const scheduleMeasurement = () => {
    cancelPendingFrame();
    if (!target) return;
    const revisionKey = getTargetRevisionKey(target);
    if (centeredRevisionKey === revisionKey) return;
    const anchorKey = getTimelineSearchOccurrenceAnchorKey(target);
    const anchor = getAnchor(anchorKey);
    if (!anchor) return;

    frame = requestFrame(() => {
      frame = requestFrame(() => {
        frame = null;
        if (!target || getTargetRevisionKey(target) !== revisionKey) return;
        const currentAnchor = getAnchor(anchorKey);
        if (!currentAnchor) return;
        currentAnchor.measure((anchorCenterY) => {
          if (!target || getTargetRevisionKey(target) !== revisionKey) return;
          const deltaY = getTimelineSearchOccurrenceScrollDelta(
            anchorCenterY,
            input.getTargetCenterY(),
          );
          centeredRevisionKey = revisionKey;
          if (deltaY !== 0) input.scrollBy(deltaY);
        });
      });
    });
  };

  return {
    setTarget(nextTarget) {
      target = nextTarget;
      centeredRevisionKey = null;
      scheduleMeasurement();
    },
    register(anchor) {
      const token = Symbol(anchor.key);
      const anchorsForKey =
        anchors.get(anchor.key) ?? new Map<symbol, TimelineSearchOccurrenceAnchor>();
      anchorsForKey.set(token, anchor);
      anchors.set(anchor.key, anchorsForKey);
      scheduleMeasurement();
      return () => {
        const currentAnchors = anchors.get(anchor.key);
        if (!currentAnchors) return;
        currentAnchors.delete(token);
        if (currentAnchors.size === 0) {
          anchors.delete(anchor.key);
        }
      };
    },
    dispose() {
      cancelPendingFrame();
      anchors.clear();
      target = null;
    },
  };
}

interface TimelineSearchOccurrenceAnchorContextValue {
  register: TimelineSearchOccurrenceAnchorController["register"];
}

const TimelineSearchOccurrenceAnchorContext =
  createContext<TimelineSearchOccurrenceAnchorContextValue | null>(null);

export function TimelineSearchOccurrenceAnchorProvider({
  target,
  scrollBy,
  targetCenterY,
  children,
}: {
  target: TimelineSearchTarget | null;
  scrollBy: (deltaY: number) => void;
  targetCenterY: number;
  children: ReactNode;
}) {
  const scrollByRef = useRef(scrollBy);
  const targetCenterYRef = useRef(targetCenterY);
  scrollByRef.current = scrollBy;
  targetCenterYRef.current = targetCenterY;

  const controller = useMemo(
    () =>
      createTimelineSearchOccurrenceAnchorController({
        scrollBy: (deltaY) => scrollByRef.current(deltaY),
        getTargetCenterY: () => targetCenterYRef.current,
      }),
    [],
  );

  useEffect(() => {
    controller.setTarget(target);
  }, [controller, target]);
  useEffect(() => () => controller.dispose(), [controller]);

  const value = useMemo(() => ({ register: controller.register }), [controller]);
  return (
    <TimelineSearchOccurrenceAnchorContext.Provider value={value}>
      {children}
    </TimelineSearchOccurrenceAnchorContext.Provider>
  );
}

/** Registers a measure callback only while this occurrence is the active result. */
export function useTimelineSearchOccurrenceAnchor(
  target: TimelineSearchTarget | null,
  measure: TimelineSearchOccurrenceAnchor["measure"],
  priority = 0,
): void {
  const context = useContext(TimelineSearchOccurrenceAnchorContext);
  const anchorKey = target ? getTimelineSearchOccurrenceAnchorKey(target) : null;
  useEffect(() => {
    if (!context || !anchorKey) return;
    return context.register({ key: anchorKey, measure, priority });
  }, [anchorKey, context, measure, priority]);
}
