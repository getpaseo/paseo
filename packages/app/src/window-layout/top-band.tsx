import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { View } from "react-native";
import { TopBandContext } from "./context";
import {
  NO_TOP_BAND_CLEARANCE,
  resolveTopBandClearance,
  type TopBandClearance,
  type WindowLayoutRect,
} from "./model";

export interface TopBandRow extends TopBandClearance {
  /** Attach to the view whose top edge `offset` is measured from. */
  ref: RefObject<View | null>;
  onLayout: (() => void) | undefined;
}

/**
 * Clearance for a row that can land in the window's top band. The measured view's frame
 * must not depend on the clearance: apply `trailing` and `top` as padding inside it.
 *
 * - `offset`: points from the measured view's top to the row, without `top`.
 * - `height`: the row's height.
 * - `minimumWidth`: the narrowest row that still fits its controls.
 * - `settled`: re-measures when it changes, for rows whose panel slides into place.
 */
export function useTopBandRow(input: {
  offset: number;
  height: number;
  minimumWidth: number;
  settled?: boolean;
}): TopBandRow {
  const { offset, height, minimumWidth, settled } = input;
  const band = useContext(TopBandContext);
  const ref = useRef<View | null>(null);
  const [frame, setFrame] = useState<WindowLayoutRect | null>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y, width, measuredHeight) =>
      setFrame((previous) =>
        previous &&
        previous.x === x &&
        previous.y === y &&
        previous.width === width &&
        previous.height === measuredHeight
          ? previous
          : { x, y, width, height: measuredHeight },
      ),
    );
  }, []);
  const active = band !== null;
  useEffect(() => {
    if (active) measure();
  }, [active, measure, settled]);
  const clearance = useMemo(
    () =>
      band && frame
        ? resolveTopBandClearance({
            row: { x: frame.x, y: frame.y + offset, width: frame.width, height },
            occlusions: band.occlusions,
            minimumWidth,
          })
        : NO_TOP_BAND_CLEARANCE,
    [band, frame, offset, height, minimumWidth],
  );
  return {
    ref,
    onLayout: active ? measure : undefined,
    trailing: clearance.trailing,
    top: clearance.top,
  };
}
