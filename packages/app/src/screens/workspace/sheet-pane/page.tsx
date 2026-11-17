import { useCallback } from "react";
import { useMenuContext, type MenuFillPageDefinition } from "@/components/ui/menu";
import { usePaneContext } from "@/panels/pane-context";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useSheetPaneBridge } from "./host";
import { SheetPane } from "./sheet-pane";

/**
 * Shows sheet tabs as pages of a menu opened from a pane, so a row's sheet replaces the list it
 * was chosen from instead of stacking a second sheet over it. Back returns to the list; Close
 * closes the menu, which uncovers the pane the menu was opened from.
 */
export function useSheetPanePage(): (sheet: SheetTab) => MenuFillPageDefinition {
  const bridge = useSheetPaneBridge();
  const { target: opener } = usePaneContext();
  return useCallback(
    (sheet) => ({
      id: sheet.tab.tabId,
      fill: true,
      content: bridge(
        // Keyed like the detached container, so the panel's descriptor hook stays fixed per page.
        <MenuSheetPane
          key={`${sheet.tab.tabId}:${sheet.tab.target.kind}`}
          sheet={sheet}
          opener={opener}
        />,
      ),
    }),
    [bridge, opener],
  );
}

function MenuSheetPane({ sheet, opener }: { sheet: SheetTab; opener: WorkspaceTabTarget }) {
  const { setOpen, goBack } = useMenuContext("MenuSheetPane");
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <SheetPane sheet={sheet} onClose={close} onBack={goBack} opener={opener} isTop />;
}
