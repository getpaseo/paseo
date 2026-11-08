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
  noteItemSizeChanged(): void;
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

  return {
    anchorRowId: () => (anchor?.kind === "row" ? anchor.rowId : null),
    hold(nextAnchor) {
      anchor = nextAnchor;
      restartCountdown();
    },
    noteItemSizeChanged() {
      if (anchor !== null) {
        restartCountdown();
      }
    },
    cancel() {
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
 * Where an end hold leaves the list, as a distance from the end. The end pin keeps the distance the
 * toggle started at, and the scroll view clamps it to the scroll room the content has left.
 */
export function settledEndHoldDistance(input: {
  distanceAtToggle: number;
  contentHeight: number;
  viewportHeight: number;
}): number {
  return Math.min(input.distanceAtToggle, Math.max(0, input.contentHeight - input.viewportHeight));
}
