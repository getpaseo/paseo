import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";

/**
 * Electron titlebar drag region plumbing.
 *
 * The drag surface is the container itself: `-webkit-app-region: drag` on the
 * marked container propagates to all non-`no-drag` descendants, and app-region
 * hit-testing follows the DOM ancestor chain. The attribute is applied via
 * `dataSet` because RNW's style compiler drops unknown CSS properties like
 * `-webkit-app-region` when compiling atomic classes.
 *
 * An earlier VS Code-style absolute overlay (first-child sibling) does not
 * work under RNW 0.21: every View defaults to `position: relative; z-index: 0`
 * and paints above the overlay, and app-region never applies to siblings.
 */

export const titlebarDragRegionDataSet = { titlebarDragRegion: "true" };

const TOP_RESIZER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: 4,
  zIndex: 1000,
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "no-drag",
};

/**
 * Top-edge resizer keeping the window resizable under the drag region
 * (VS Code titlebarpart.css:249-256). Returns null on non-Electron.
 * Pair with `titlebarDragRegionDataSet` on the positioned container.
 */
export function TitlebarDragRegion() {
  if (isNative || !getIsElectronRuntime()) {
    return null;
  }

  return <div style={TOP_RESIZER_STYLE} />;
}
