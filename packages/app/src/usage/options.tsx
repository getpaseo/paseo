import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Settings } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useCallback, useMemo } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { HostMenuItem } from "@/components/hosts/host-menu-item";
import { getHostPickerLabel } from "@/components/hosts/host-picker";
import {
  mutedIconColorMapping,
  useIconButtonChromeGlyphSize,
} from "@/components/ui/icon-button-chrome";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { MenuSettingsRows, SettingsRow, SettingsSwitch } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Alert } from "@/components/ui/alert";
import { useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { useUsageSetting } from "./setting";
import { useUsageDisplay, type UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import { hasHostChoice, type UsageHostSelection } from "./hosts";
import type { UsageDisplayAs } from "./preferences";
import { UsageSourceIcon } from "./source-icon";
import type { UsageReportEntry } from "./types";

const ThemedSettings = withUnistyles(Settings);

const HOST_PAGE = "host";
const SOURCES_PAGE = "sources";

/**
 * The shared usage preferences, opened from a cog as a popover or compact sheet. Host and Sources
 * open as pages of the same surface, so a compact sheet never opens a second sheet over it.
 */
export function UsageOptions({
  serverId,
  hostSelection,
  reports = [],
  display: providedDisplay,
  open,
  onOpenChange,
}: {
  serverId: string | null;
  hostSelection?: UsageHostSelection;
  reports?: readonly UsageReportEntry[];
  display?: UsageDisplay;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const setting = useUsageSetting(serverId);
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  const { t } = useTranslation();
  const displayAsOptions: SegmentedControlOption<UsageDisplayAs>[] = [
    { value: "used", label: t("providerUsage.displayUsed"), testID: "usage-display-used" },
    {
      value: "remaining",
      label: t("providerUsage.displayRemaining"),
      testID: "usage-display-remaining",
    },
  ];
  const compact = useIsCompactFormFactor();
  const glyphSize = useIconButtonChromeGlyphSize("small", compact);
  const fallbackDisplay = useUsageDisplay(providedDisplay ? [] : reports).display;
  const display = providedDisplay ?? fallbackDisplay;
  const { inSidebar, setInSidebar } = useUsageInSidebar();
  const hostChoice = hasHostChoice(hostSelection) ? hostSelection : null;
  const arrangedReports = useMemo(() => display.arrange(reports), [display, reports]);
  const hasSources = arrangedReports.length > 0;
  const shownCount = useMemo(
    () => arrangedReports.filter((entry) => display.isCardOn(entry)).length,
    [arrangedReports, display],
  );
  const pages = useMemo<MenuPageDefinition[] | undefined>(() => {
    const definitions: MenuPageDefinition[] = [];
    if (hostChoice) {
      definitions.push({
        id: HOST_PAGE,
        title: t("providerUsage.host"),
        content: <UsageHostPage hostSelection={hostChoice} />,
      });
    }
    if (hasSources) {
      definitions.push({
        id: SOURCES_PAGE,
        title: t("providerUsage.sources"),
        content: <UsageSourcesPage reports={arrangedReports} display={display} />,
      });
    }
    return definitions.length > 0 ? definitions : undefined;
  }, [arrangedReports, display, hasSources, hostChoice, t]);
  const hasSubTriggers = Boolean(hostChoice || hasSources);
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <ToolbarButton
        kind="menu"
        label={t("providerUsage.options")}
        compact={compact}
        testID="usage-options-menu"
      >
        <ThemedSettings size={glyphSize} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
      <DropdownMenuContent
        align="end"
        width={340}
        sheetTitle={t("providerUsage.options")}
        pages={pages}
        testID="usage-options-surface"
      >
        {hostChoice ? (
          <DropdownMenuSubTrigger
            id={HOST_PAGE}
            value={getHostPickerLabel(hostChoice.hosts, hostChoice.serverId)}
            testID="usage-options-host"
          >
            {t("providerUsage.host")}
          </DropdownMenuSubTrigger>
        ) : null}
        {hasSources ? (
          <DropdownMenuSubTrigger
            id={SOURCES_PAGE}
            value={t("providerUsage.sourcesCount", {
              shown: shownCount,
              total: arrangedReports.length,
            })}
            testID="usage-options-sources"
          >
            {t("providerUsage.sources")}
          </DropdownMenuSubTrigger>
        ) : null}
        <View
          style={hasSubTriggers ? settingsStyles.rowBorder : undefined}
          testID="usage-options-fields"
        >
          <MenuSettingsRows>
            {setting.error ? <Alert variant="error" description={setting.error.message} /> : null}
            {setting.supported ? (
              <SettingsSwitch
                label={t("providerUsage.checkUsage")}
                hint={t("providerUsage.checkUsageHint", { host: hostLabel })}
                disabled={!setting.ready}
                value={setting.enabled}
                onValueChange={setting.setEnabled}
              />
            ) : null}
            <View style={setting.supported ? settingsStyles.rowBorder : undefined}>
              <SettingsSwitch
                label={t("providerUsage.showInSidebar")}
                hint={t("providerUsage.showInSidebarHint")}
                value={inSidebar}
                onValueChange={setInSidebar}
                testID="usage-show-in-sidebar"
              />
            </View>
            <View style={settingsStyles.rowBorder}>
              <SettingsRow label={t("providerUsage.displayAs")}>
                <SegmentedControl
                  options={displayAsOptions}
                  value={display.displayAs}
                  onValueChange={display.setDisplayAs}
                  testID="usage-display-as"
                />
              </SettingsRow>
            </View>
          </MenuSettingsRows>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageHostPage({ hostSelection }: { hostSelection: UsageHostSelection }) {
  return (
    <>
      {hostSelection.hosts.map((host) => (
        <HostMenuItem
          key={host.serverId}
          serverId={host.serverId}
          label={host.label}
          selected={host.serverId === hostSelection.serverId}
          onSelect={hostSelection.onSelect}
          testID={`usage-options-host-${host.serverId}`}
        />
      ))}
    </>
  );
}

function UsageSourcesPage({
  reports,
  display,
}: {
  reports: readonly UsageReportEntry[];
  display: UsageDisplay;
}) {
  const { t } = useTranslation();
  const inactiveLabel = t("providerUsage.providerInactive");
  return (
    <>
      {reports.map((entry) => (
        <UsageSourceMenuItem
          key={entry.id}
          entry={entry}
          on={display.isCardOn(entry)}
          onToggle={display.setCardOn}
          inactiveLabel={inactiveLabel}
        />
      ))}
    </>
  );
}

function UsageSourceMenuItem({
  entry,
  on,
  onToggle,
  inactiveLabel,
}: {
  entry: UsageReportEntry;
  on: boolean;
  onToggle: (reportId: string, on: boolean) => void;
  inactiveLabel: string;
}) {
  const handleSelect = useCallback(() => onToggle(entry.id, !on), [entry.id, on, onToggle]);
  const leading = useMemo(
    () => <UsageSourceIcon svg={entry.icon ?? null} size={14} />,
    [entry.icon],
  );
  const description =
    [entry.account.label, !on && entry.defaultEnabled === false ? inactiveLabel : null]
      .filter(Boolean)
      .join(" · ") || undefined;
  return (
    <DropdownMenuCheckboxItem
      leading={leading}
      description={description}
      checked={on}
      onToggle={handleSelect}
      testID={`usage-source-toggle-${entry.id}`}
    >
      {entry.sourceLabel}
    </DropdownMenuCheckboxItem>
  );
}
