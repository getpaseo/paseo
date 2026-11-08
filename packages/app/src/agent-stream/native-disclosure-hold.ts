import type { DisclosureTriggerEdge } from "./strategy";

/** What a disclosure hold keeps in place: the top of a row, or the end of the content. */
export type DisclosureAnchor = { kind: "row"; rowId: string } | { kind: "end" };

/**
 * The native viewport's disclosure hold. While it holds a row anchor, that row is the only row the
 * list may anchor on (`disclosureAnchor`). The hold ends once item sizes stop changing for
 * `quietFrames` frames: the list measures the toggled row and any rows it inserted over one or more
 * frames, and end following must not resume between the change and the list's last layout
 * correction.
 */
export interface NativeDisclosureHold {
  /** The row the list may anchor on; null outside a hold and while the hold keeps the end. */
  anchorRowId(): string | null;
  hold(anchor: DisclosureAnchor): void;
  /**
   * Holds on the next frame and runs `apply` there, for a toggle that has to land after a commit
   * already on its way. `resolveAnchor` runs in that frame, because rows may land while it waits.
   * A later hold or a cancel lands a waiting toggle right away.
   */
  holdNextFrame(
    resolveAnchor: () => DisclosureAnchor,
    apply: (anchor: DisclosureAnchor) => void,
  ): void;
  noteItemSizeChanged(): void;
  /** Drops the hold without releasing it. */
  cancel(): void;
}

export function createNativeDisclosureHold(input: {
  quietFrames: number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  onRelease: () => void;
}): NativeDisclosureHold {
  let anchor: DisclosureAnchor | null = null;
  let frameId: number | null = null;
  let remainingFrames = 0;
  let waitingToggle: { frameId: number; land: () => void } | null = null;

  const stopCountdown = () => {
    if (frameId !== null) {
      input.cancelFrame(frameId);
      frameId = null;
    }
  };

  const tick = () => {
    remainingFrames -= 1;
    if (remainingFrames > 0) {
      frameId = input.requestFrame(tick);
      return;
    }
    frameId = null;
    anchor = null;
    input.onRelease();
  };

  const restartCountdown = () => {
    stopCountdown();
    remainingFrames = input.quietFrames;
    frameId = input.requestFrame(tick);
  };

  const landWaitingToggle = () => {
    if (!waitingToggle) return;
    const { frameId: waitingFrameId, land } = waitingToggle;
    waitingToggle = null;
    input.cancelFrame(waitingFrameId);
    land();
  };

  const startHold = (nextAnchor: DisclosureAnchor) => {
    anchor = nextAnchor;
    restartCountdown();
  };

  return {
    anchorRowId: () => (anchor?.kind === "row" ? anchor.rowId : null),
    hold(nextAnchor) {
      landWaitingToggle();
      startHold(nextAnchor);
    },
    holdNextFrame(resolveAnchor, apply) {
      landWaitingToggle();
      const waitingFrameId = input.requestFrame(() => {
        waitingToggle = null;
        const nextAnchor = resolveAnchor();
        startHold(nextAnchor);
        apply(nextAnchor);
      });
      waitingToggle = { frameId: waitingFrameId, land: () => apply(resolveAnchor()) };
    },
    noteItemSizeChanged() {
      if (anchor !== null) {
        restartCountdown();
      }
    },
    cancel() {
      landWaitingToggle();
      stopCountdown();
      anchor = null;
    },
  };
}

/**
 * What the list keeps in place while a disclosure toggles `rowId`. LegendList restores row tops, so
 * a trigger on the bottom edge of its row anchors the row below: that row's top is the toggled
 * row's bottom. The last row's bottom is the end of the content.
 */
export function disclosureAnchor(
  rows: readonly { id: string }[],
  rowId: string,
  triggerEdge: DisclosureTriggerEdge,
): DisclosureAnchor {
  if (triggerEdge === "top") return { kind: "row", rowId };
  const index = rows.findIndex((row) => row.id === rowId);
  const below = rows[index + 1];
  return below ? { kind: "row", rowId: below.id } : { kind: "end" };
}

/**
 * The list's distance from the end during an end hold. The end pin keeps the distance through every
 * content size change, and the scroll view clamps it to the scroll room the content has at that
 * moment. A clamp is permanent: content that grows afterwards does not bring the distance back.
 */
export function createEndHoldDistance(distanceAtToggle: number): EndHoldDistance {
  let distance = distanceAtToggle;
  return {
    noteContentSize({ contentHeight, viewportHeight }) {
      distance = Math.min(distance, Math.max(0, contentHeight - viewportHeight));
    },
    current: () => distance,
  };
}

export interface EndHoldDistance {
  noteContentSize(input: { contentHeight: number; viewportHeight: number }): void;
  current(): number;
}
