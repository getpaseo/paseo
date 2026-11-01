/**
 * A workspace tab shown in a sheet. One pane — header, body, bottom inset, focus — behind every
 * sheet container: the workspace's sheet tabs, and pages of a menu that shows a sheet in place.
 *
 * See docs/explorer-sidebar.md.
 */

export {
  SheetPaneHostProvider,
  useSheetPaneBridge,
  useSheetPaneHost,
  useSheetPaneHostIfAny,
  type SheetPaneHost,
} from "./host";
export { SheetPane, useLeaveSheet, type SheetPaneProps } from "./sheet-pane";
export { useSheetPanePage } from "./page";
