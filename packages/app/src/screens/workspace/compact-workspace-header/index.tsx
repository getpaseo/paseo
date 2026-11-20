import { Fragment, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePanelStore } from "@/stores/panel-store";
import { CompactHeader } from "@/components/headers/compact-header";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
} from "@/window-layout";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  tabSwitcher: ReactNode;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full";
  isRouteFocused: boolean;
  isCompact: boolean;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  tabSwitcher,
  serverId,
  headerVariant,
  isRouteFocused,
  isCompact,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId],
  );
  const symbols = {
    "tab-count": tabSwitcher,
    overflow: children,
    explorer: (
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    ),
  };
  const actions = resolveWorkspaceBarActions(headerVariant).map((symbol) => (
    <Fragment key={symbol}>{symbols[symbol]}</Fragment>
  ));

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          navigation="menu"
          title={title}
          titleTestID="workspace-header-title"
          subtitle={projectRow}
          loading={isLoading}
          actions={actionsInBar ? undefined : actions}
        />
      ) : null}
      <WorkspaceWindowActions isRouteFocused={isRouteFocused} isCompact={isCompact}>
        {actions}
      </WorkspaceWindowActions>
    </IconButtonChromeProvider>
  );
}

// Panel changes only affect the portaled controls. Keep their subscription below the
// workspace and header so opening a sidebar does not render the chat or rebuild its actions.
function WorkspaceWindowActions({
  isRouteFocused,
  isCompact,
  children,
}: {
  isRouteFocused: boolean;
  isCompact: boolean;
  children: ReactNode;
}) {
  const active = usePanelStore(
    (state) => isRouteFocused && (!isCompact || state.mobilePanel.target === "agent"),
  );
  return <WindowLayoutActions active={active}>{children}</WindowLayoutActions>;
}
