import type { DisclosureTriggerEdge } from "./strategy";

/**
 * The native viewport's disclosure hold. While it holds, its anchor row is the only row the list
 * may anchor on (`disclosureAnchorRowId`). The hold ends once item sizes stop changing for `quietFrames` frames: the list
 * measures the toggled row and any rows it inserted over one or more frames, and end following
 * must not resume between the change and the list's last layout correction.
 */
export interface NativeDisclosureHold {
  anchorRowId(): string | null;
  hold(anchorRowId: string): void;
  noteItemSizeChanged(): void;
  cancel(): void;
}

export function createNativeDisclosureHold(input: {
  quietFrames: number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  onRelease: () => void;
}): NativeDisclosureHold {
  let anchorRowId: string | null = null;
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
    anchorRowId = null;
    input.onRelease();
  };

  const restartCountdown = () => {
    stopCountdown();
    remainingFrames = input.quietFrames;
    frameId = input.requestFrame(tick);
  };

  return {
    anchorRowId: () => anchorRowId,
    hold(nextAnchorRowId) {
      anchorRowId = nextAnchorRowId;
      restartCountdown();
    },
    noteItemSizeChanged() {
      if (anchorRowId !== null) {
        restartCountdown();
      }
    },
    cancel() {
      stopCountdown();
      anchorRowId = null;
    },
  };
}

/**
 * The row LegendList keeps in place while a disclosure holds `rowId`. LegendList restores row tops,
 * so a trigger on the bottom edge of its row anchors the row below: that row's top is the held
 * row's bottom. The last row has no row below and keeps its top.
 */
export function disclosureAnchorRowId(
  rows: readonly { id: string }[],
  rowId: string,
  triggerEdge: DisclosureTriggerEdge,
): string {
  if (triggerEdge === "top") return rowId;
  const index = rows.findIndex((row) => row.id === rowId);
  return rows[index + 1]?.id ?? rowId;
}
