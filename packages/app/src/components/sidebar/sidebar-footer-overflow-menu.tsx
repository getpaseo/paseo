import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  CircleGauge,
  CircleHelp,
  FolderPlus,
  Plus,
  Server,
  Settings,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import type { SidebarFooterAction } from "@/components/sidebar-footer-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { orderHostsLocalFirst } from "@/types/host-connection";
import { useOpenSidebarUsage } from "@/usage";
import { SidebarFooterMenuTrigger } from "./sidebar-footer-menu-trigger";
import { SidebarHelpMenuItems } from "./sidebar-help-menu";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedCircleGauge = withUnistyles(CircleGauge);
const ThemedServer = withUnistyles(Server);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedSettings = withUnistyles(Settings);
const ThemedPlus = withUnistyles(Plus);
const addProjectLeading = <ThemedFolderPlus size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const usageLeading = <ThemedCircleGauge size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const hostsLeading = <ThemedServer size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const helpLeading = <ThemedCircleHelp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const settingsLeading = <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
const addHostLeading = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;

const HOSTS_PAGE_ID = "hosts";
const HELP_PAGE_ID = "help";

export interface SidebarFooterOverflowMenuProps {
  /** The footer actions that did not fit in the row, in row order. */
  actions: readonly SidebarFooterAction[];
  labels: { addProject: string; hosts: string; settings: string; usage: string };
  onAddProject: () => void;
  onSettings: () => void;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}

/**
 * The caret at the end of a footer row too narrow for every action. It lists the actions that
 * lost their place, with the same test IDs they carry in the row; Hosts and Help, menus of their
 * own in the row, open as pages of this menu.
 */
export function SidebarFooterOverflowMenu({
  actions,
  labels,
  onAddProject,
  onSettings,
  onAddHost,
  onOpenHostSettings,
}: SidebarFooterOverflowMenuProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openUsage = useOpenSidebarUsage();
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const helpLabel = t("sidebar.help.trigger");
  const addProjectTrailing = useMemo(
    () => (newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null),
    [newAgentKeys],
  );
  const settingsTrailing = useMemo(
    () => (settingsKeys ? <Shortcut chord={settingsKeys} /> : null),
    [settingsKeys],
  );

  const pages = useMemo((): MenuPageDefinition[] => {
    const result: MenuPageDefinition[] = [];
    if (actions.includes("hosts")) {
      result.push({
        id: HOSTS_PAGE_ID,
        title: labels.hosts,
        content: <HostsPage onAddHost={onAddHost} onOpenHostSettings={onOpenHostSettings} />,
      });
    }
    if (actions.includes("help")) {
      result.push({ id: HELP_PAGE_ID, title: helpLabel, content: <SidebarHelpMenuItems /> });
    }
    return result;
  }, [actions, helpLabel, labels.hosts, onAddHost, onOpenHostSettings]);

  function renderAction(action: SidebarFooterAction): ReactElement {
    switch (action) {
      case "add-project":
        return (
          <DropdownMenuItem
            key={action}
            testID="sidebar-add-project"
            leading={addProjectLeading}
            trailing={addProjectTrailing}
            onSelect={onAddProject}
          >
            {labels.addProject}
          </DropdownMenuItem>
        );
      case "usage":
        return (
          <DropdownMenuItem
            key={action}
            testID="sidebar-usage-icon"
            leading={usageLeading}
            onSelect={openUsage}
          >
            {labels.usage}
          </DropdownMenuItem>
        );
      case "hosts":
        return (
          <DropdownMenuSubTrigger
            key={action}
            id={HOSTS_PAGE_ID}
            testID="sidebar-hosts-trigger"
            leading={hostsLeading}
          >
            {labels.hosts}
          </DropdownMenuSubTrigger>
        );
      case "help":
        return (
          <DropdownMenuSubTrigger
            key={action}
            id={HELP_PAGE_ID}
            testID="sidebar-help"
            leading={helpLeading}
          >
            {helpLabel}
          </DropdownMenuSubTrigger>
        );
      case "settings":
        return (
          <DropdownMenuItem
            key={action}
            testID="sidebar-settings"
            leading={settingsLeading}
            trailing={settingsTrailing}
            onSelect={onSettings}
          >
            {labels.settings}
          </DropdownMenuItem>
        );
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <SidebarFooterMenuTrigger
        icon={ChevronUp}
        label={t("sidebar.actions.moreActions")}
        menuOpen={open}
        testID="sidebar-footer-overflow"
      />
      <DropdownMenuContent
        side="top"
        align="end"
        offset={8}
        width={240}
        pages={pages}
        scrollable
        testID="sidebar-footer-overflow-menu"
      >
        {actions.map(renderAction)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The host picker's choices as a menu page: each host opens its settings, then Add host. */
function HostsPage({
  onAddHost,
  onOpenHostSettings,
}: {
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );

  return (
    <>
      {orderedHosts.map((host) => (
        <HostRow
          key={host.serverId}
          serverId={host.serverId}
          label={host.label}
          onOpenHostSettings={onOpenHostSettings}
        />
      ))}
      {orderedHosts.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem testID="sidebar-host-add" leading={addHostLeading} onSelect={onAddHost}>
        {t("settings.addHost")}
      </DropdownMenuItem>
    </>
  );
}

function HostRow({
  serverId,
  label,
  onOpenHostSettings,
}: {
  serverId: string;
  label: string;
  onOpenHostSettings: (serverId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onOpenHostSettings(serverId),
    [onOpenHostSettings, serverId],
  );
  const leading = useMemo(() => <HostStatusDotSlot serverId={serverId} />, [serverId]);
  return (
    <DropdownMenuItem
      testID={`sidebar-host-row-${serverId}`}
      leading={leading}
      onSelect={handleSelect}
    >
      {label}
    </DropdownMenuItem>
  );
}
