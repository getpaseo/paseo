import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { TimelineSearchTarget } from "./search-target";

export interface TimelineSearchOccurrenceAnchor {
  key: string;
  /**
   * Exact spans win over containing-block fallbacks for the same occurrence.
   * When more than one anchor is registered under the same key, the
   * controller tries them in descending priority order: if the current
   * highest-priority anchor's `measure` doesn't call back within one extra
   * frame — native `measureInWindow` crosses the RN bridge asynchronously
   * and can silently never report (a stale ref, an unmounted node, or a
   * consumer's own `?.()` optional call swallowing a missing method) — the
   * controller falls back to the next-priority anchor instead of leaving the
   * viewport permanently uncorrected. Register a coarser containing-block
   * anchor at a lower priority alongside a precise per-span one to get this
   * degradation path for free.
   */
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
  let pendingFrames: number[] = [];
  let centeredRevisionKey: string | null = null;

  // Highest priority first, so a precise per-span anchor is always tried
  // before a coarser containing-block fallback registered under the same
  // key.
  const getAnchorCandidates = (key: string): TimelineSearchOccurrenceAnchor[] => {
    const anchorsForKey = anchors.get(key);
    if (!anchorsForKey) return [];
    return [...anchorsForKey.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  };

  const cancelPendingFrames = () => {
    for (const handle of pendingFrames) {
      cancelFrame(handle);
    }
    pendingFrames = [];
  };

  const scheduleFrame = (callback: () => void): void => {
    pendingFrames.push(requestFrame(callback));
  };

  /**
   * Tries the highest-priority remaining candidate for this occurrence. If
   * it hasn't reported within one extra frame after measuring, falls back to
   * the next-priority candidate — see the `priority` doc comment above for
   * why a `measure` callback can silently never report.
   */
  const attemptMeasurement = (
    candidates: readonly TimelineSearchOccurrenceAnchor[],
    candidateIndex: number,
    revisionKey: string,
  ): void => {
    const anchor = candidates[candidateIndex];
    if (!anchor) return;

    scheduleFrame(() => {
      scheduleFrame(() => {
        if (!target || getTargetRevisionKey(target) !== revisionKey) return;
        let reported = false;
        anchor.measure((anchorCenterY) => {
          if (reported || !target || getTargetRevisionKey(target) !== revisionKey) return;
          reported = true;
          const deltaY = getTimelineSearchOccurrenceScrollDelta(
            anchorCenterY,
            input.getTargetCenterY(),
          );
          centeredRevisionKey = revisionKey;
          if (deltaY !== 0) input.scrollBy(deltaY);
        });
        scheduleFrame(() => {
          if (reported) return;
          if (!target || getTargetRevisionKey(target) !== revisionKey) return;
          attemptMeasurement(candidates, candidateIndex + 1, revisionKey);
        });
      });
    });
  };

  const scheduleMeasurement = () => {
    cancelPendingFrames();
    if (!target) return;
    const revisionKey = getTargetRevisionKey(target);
    if (centeredRevisionKey === revisionKey) return;
    const anchorKey = getTimelineSearchOccurrenceAnchorKey(target);
    const candidates = getAnchorCandidates(anchorKey);
    if (candidates.length === 0) return;
    attemptMeasurement(candidates, 0, revisionKey);
  };

  return {
    setTarget(nextTarget) {
      const nextRevisionKey = nextTarget ? getTargetRevisionKey(nextTarget) : null;
      const previousRevisionKey = target ? getTargetRevisionKey(target) : null;
      target = nextTarget;
      // Only reset once the occurrence/revision actually changes — a caller
      // re-supplying an equivalent target (e.g. a stream flush re-render
      // that hands the provider a new-but-equal target object) must not
      // force a redundant re-measure/re-scroll of an already-centered
      // occurrence.
      if (nextRevisionKey !== previousRevisionKey) {
        centeredRevisionKey = null;
      }
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
      cancelPendingFrames();
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
