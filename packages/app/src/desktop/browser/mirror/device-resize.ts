import type { DeviceSizeSelection } from "@/desktop/browser/device-sizes";
import type { PaneSize } from "./viewport";

export type MirrorDeviceResize =
  | { status: "resize"; width: number; height: number }
  | { status: "unavailable" };

export interface MirrorDeviceResizeInput {
  selection: DeviceSizeSelection;
  paneSize: PaneSize | null;
}

/**
 * The dimensions a picked device size sends to the host that owns the tab.
 *
 * "Responsive" has no remote equivalent: the host handler only sets fixed
 * viewports and `resize` requires positive dimensions, so nothing can put the
 * remote tab back into responsive mode. The local pane frees its webview to fill
 * the pane; from the mirror the closest thing is sizing the remote tab to this
 * viewer's pane, so "Responsive" means "fit my window" — which is unavailable
 * until the pane has been laid out.
 */
export function resolveMirrorDeviceResize(input: MirrorDeviceResizeInput): MirrorDeviceResize {
  const width = input.selection.size?.width ?? input.paneSize?.width;
  const height = input.selection.size?.height ?? input.paneSize?.height;
  if (!width || !height) {
    return { status: "unavailable" };
  }
  return { status: "resize", width: Math.round(width), height: Math.round(height) };
}
