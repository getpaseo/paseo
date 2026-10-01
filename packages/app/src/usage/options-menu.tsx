import { Settings } from "lucide-react-native";
import { useCallback } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";

const ThemedSettings = withUnistyles(Settings);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

/**
 * The usage title row's options: Refresh every report, whether percents read as used or
 * remaining, and whether the sidebar shows the Usage item (the same switch as Settings > Sidebar). The trigger spins while a refresh is in flight, since the menu hides the one it came
 * from.
 */
export function UsageOptionsMenu({
  display,
  busy,
  onRefresh,
}: {
  display: UsageDisplay;
  busy: boolean;
  onRefresh: () => void;
}) {
  const compact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(compact);
  const { displayAs, setDisplayAs } = display;
  const showUsed = useCallback(() => setDisplayAs("used"), [setDisplayAs]);
  const showRemaining = useCallback(() => setDisplayAs("remaining"), [setDisplayAs]);
  const sidebarItems = useSidebarNavItems("footer");
  const inSidebar = sidebarItems.items.some((item) => item.key === "usage" && item.visible);
  const { setVisible } = sidebarItems;
  const toggleInSidebar = useCallback(
    () => setVisible("usage", !inSidebar),
    [inSidebar, setVisible],
  );
  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={usageCopy.options}
        compact={compact}
        testID="usage-options-menu"
      >
        {busy ? (
          <ThemedLoadingSpinner size={iconSize} uniProps={extraMutedIconColorMapping} />
        ) : (
          <ThemedSettings size={iconSize} uniProps={extraMutedIconColorMapping} />
        )}
      </ToolbarButton>
      <DropdownMenuContent
        align="end"
        width={200}
        sheetTitle={usageCopy.options}
        testID="usage-options-menu-content"
      >
        <DropdownMenuItem
          status={busy ? "pending" : "idle"}
          pendingLabel={usageCopy.refreshing}
          onSelect={onRefresh}
          testID="usage-refresh-all"
        >
          {usageCopy.refresh}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{usageCopy.displayAs}</DropdownMenuLabel>
        <DropdownMenuItem
          selected={displayAs === "used"}
          onSelect={showUsed}
          testID="usage-display-used"
        >
          {usageCopy.displayUsed}
        </DropdownMenuItem>
        <DropdownMenuItem
          selected={displayAs === "remaining"}
          onSelect={showRemaining}
          testID="usage-display-remaining"
        >
          {usageCopy.displayRemaining}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          selected={inSidebar}
          onSelect={toggleInSidebar}
          testID="usage-show-in-sidebar"
        >
          {usageCopy.showInSidebar}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
