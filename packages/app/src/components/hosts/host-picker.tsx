import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, Plus, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { Combobox, type ComboboxProps } from "@/components/ui/combobox";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { defaultHostAppearance, type HostAppearance } from "@/hosts/appearance";
import { HostConnectionLine, HostIconGlyph, HostLatencyLabel } from "@/hosts/host-icon";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatus,
  useHosts,
} from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { orderHostsLocalFirst } from "@/types/host-connection";
import {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  ENABLE_BUILT_IN_DAEMON_OPTION_ID,
  getHostPickerLabel,
} from "./host-picker-constants";

export {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  ENABLE_BUILT_IN_DAEMON_OPTION_ID,
  getHostPickerLabel,
};

const SEARCHABLE_THRESHOLD = 10;
const DEFAULT_DESKTOP_MIN_WIDTH = 328;
const HOST_ROW_ICON_SIZE = 16;
type RenderHostOption = NonNullable<ComboboxProps["renderOption"]>;

const ThemedCheck = withUnistyles(Check);
const ThemedPlus = withUnistyles(Plus);
const ThemedServer = withUnistyles(Server);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface HostPickerHost {
  serverId: string;
  label: string;
}

export function HostStatusDotSlot({ serverId }: { serverId: string }): ReactElement {
  return (
    <View style={styles.statusDotSlot}>
      <HostStatusDot serverId={serverId} />
    </View>
  );
}

export interface HostPickerOptionProps {
  serverId: string;
  label: string;
  appearance: HostAppearance;
  selected?: boolean;
  active: boolean;
  onPress: () => void;
  testID?: string;
}

export function HostPickerOption({
  serverId,
  label,
  appearance,
  selected,
  active,
  onPress,
  testID,
}: HostPickerOptionProps): ReactElement {
  const status = useHostRuntimeConnectionStatus(serverId);
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const isOffline = status === "offline" || status === "error";

  return (
    <View
      style={styles.rowEnvelope}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={testID}
        onPress={onPress}
        highlightStyle={styles.rowHighlighted}
        style={[styles.hostRow, (hovered || active) && styles.rowHighlighted]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={styles.leadingCluster}>
          <View style={styles.leadingRailSlot}>
            <HostStatusDot serverId={serverId} />
          </View>
          <HostIconGlyph
            icon={appearance.icon}
            color={appearance.color}
            size={HOST_ROW_ICON_SIZE}
          />
        </View>
        <View style={styles.hostBody}>
          <Text style={[styles.hostName, isOffline && styles.hostNameMuted]} numberOfLines={1}>
            {label}
          </Text>
          <HostConnectionLine serverId={serverId} />
        </View>
        <View style={styles.hostTrailing}>
          <HostLatencyLabel serverId={serverId} />
          {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={mutedIconMapping} /> : null}
        </View>
      </PressHighlight>
    </View>
  );
}

function AllHostsOption({
  active,
  selected,
  onPress,
  testID,
}: {
  active: boolean;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const label = t("sidebar.display.hostFilter.all");

  return (
    <View
      style={styles.rowEnvelope}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={testID}
        onPress={onPress}
        highlightStyle={styles.rowHighlighted}
        style={[styles.actionRow, (hovered || active) && styles.rowHighlighted]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={styles.leadingRailSlot}>
          <ThemedServer size={HOST_ROW_ICON_SIZE} uniProps={mutedIconMapping} />
        </View>
        <Text style={styles.actionLabel} numberOfLines={1}>
          {label}
        </Text>
        {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={mutedIconMapping} /> : null}
      </PressHighlight>
    </View>
  );
}

function FooterActionRow({
  kind,
  onPress,
  testID,
}: {
  kind: "add" | "enableBuiltInDaemon";
  onPress: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const label = kind === "add" ? t("settings.addHost") : t("settings.enableBuiltInDaemon");

  return (
    <View
      style={styles.rowEnvelope}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={testID}
        onPress={onPress}
        highlightStyle={styles.rowHighlighted}
        style={[styles.actionRow, hovered && styles.rowHighlighted]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={styles.leadingRailSlot}>
          {kind === "add" ? (
            <ThemedPlus size={HOST_ROW_ICON_SIZE} uniProps={mutedIconMapping} />
          ) : (
            <ThemedServer size={HOST_ROW_ICON_SIZE} uniProps={mutedIconMapping} />
          )}
        </View>
        <Text style={styles.actionLabel} numberOfLines={1}>
          {label}
        </Text>
      </PressHighlight>
    </View>
  );
}

export interface HostPickerProps {
  hosts: HostPickerHost[];
  value: string;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<View | null>;
  includeAllHost?: boolean;
  includeAddHost?: boolean;
  onAddHost?: () => void;
  includeEnableBuiltInDaemon?: boolean;
  onEnableBuiltInDaemon?: () => void;
  showActiveConnection?: boolean;
  searchable?: boolean;
  title?: string;
  desktopPlacement?: ComboboxProps["desktopPlacement"];
  desktopMinWidth?: number;
  addHostTestID?: string;
  hostOptionTestID?: (serverId: string) => string;
  children: ReactNode;
}

export function HostPicker({
  hosts,
  value,
  onSelect,
  open,
  onOpenChange,
  anchorRef,
  includeAllHost,
  includeAddHost,
  onAddHost,
  includeEnableBuiltInDaemon,
  onEnableBuiltInDaemon,
  searchable,
  title,
  desktopPlacement = "bottom-start",
  desktopMinWidth = DEFAULT_DESKTOP_MIN_WIDTH,
  addHostTestID,
  hostOptionTestID,
  children,
}: HostPickerProps): ReactElement {
  const { t } = useTranslation();
  const localServerId = useLocalDaemonServerId();
  const allHostProfiles = useHosts();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );

  const appearanceByServerId = useMemo(() => {
    const map = new Map<string, HostAppearance>();
    for (const profile of allHostProfiles) {
      map.set(profile.serverId, profile.appearance);
    }
    return map;
  }, [allHostProfiles]);

  useEffect(() => {
    if (!open) return;
    getHostRuntimeStore().refreshActiveLatencies(orderedHosts.map((host) => host.serverId));
  }, [open, orderedHosts]);

  const options = useMemo(() => {
    const hostOptions = orderedHosts.map((host) => ({ id: host.serverId, label: host.label }));
    if (includeAllHost) {
      hostOptions.unshift({ id: ALL_HOSTS_OPTION_ID, label: t("sidebar.display.hostFilter.all") });
    }
    return hostOptions;
  }, [orderedHosts, includeAllHost, t]);

  const isSearchable = searchable === true && orderedHosts.length > SEARCHABLE_THRESHOLD;
  const resolvedTitle = title ?? t("sidebar.actions.hosts");

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      onOpenChange(false);
    },
    [onOpenChange, onSelect],
  );

  const handleAddHost = useCallback(() => {
    onOpenChange(false);
    onAddHost?.();
  }, [onAddHost, onOpenChange]);

  const handleEnableBuiltInDaemon = useCallback(() => {
    onOpenChange(false);
    onEnableBuiltInDaemon?.();
  }, [onEnableBuiltInDaemon, onOpenChange]);

  const renderOption = useCallback<RenderHostOption>(
    ({ option, selected, active, onPress }) => {
      if (option.id === ALL_HOSTS_OPTION_ID) {
        return (
          <AllHostsOption
            active={active}
            selected={selected}
            onPress={onPress}
            testID={hostOptionTestID?.(option.id)}
          />
        );
      }
      const appearance = appearanceByServerId.get(option.id) ?? defaultHostAppearance();
      return (
        <HostPickerOption
          serverId={option.id}
          label={option.label}
          appearance={appearance}
          selected={selected}
          active={active}
          onPress={onPress}
          testID={hostOptionTestID?.(option.id)}
        />
      );
    },
    [appearanceByServerId, hostOptionTestID],
  );

  const footer = useMemo(() => {
    if (!includeAddHost && !includeEnableBuiltInDaemon) return undefined;
    return (
      <View style={styles.footerGroup}>
        {includeAddHost ? (
          <FooterActionRow kind="add" onPress={handleAddHost} testID={addHostTestID} />
        ) : null}
        {includeEnableBuiltInDaemon ? (
          <FooterActionRow kind="enableBuiltInDaemon" onPress={handleEnableBuiltInDaemon} />
        ) : null}
      </View>
    );
  }, [
    addHostTestID,
    handleAddHost,
    handleEnableBuiltInDaemon,
    includeAddHost,
    includeEnableBuiltInDaemon,
  ]);

  return (
    <>
      {children}
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        renderOption={renderOption}
        searchable={isSearchable}
        searchPlaceholder={t("sidebar.host.searchPlaceholder")}
        title={resolvedTitle}
        footer={footer}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        desktopPlacement={desktopPlacement}
        desktopMinWidth={desktopMinWidth}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  statusDotSlot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  rowEnvelope: {
    position: "relative",
  },
  // Shared leading rail: the status dot on host rows and the '+' / All hosts glyph share the
  // exact same 16px centered column.
  leadingRailSlot: {
    width: HOST_ROW_ICON_SIZE,
    height: HOST_ROW_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  leadingCluster: {
    flexDirection: "row",
    alignItems: "center",
    height: 18,
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surface1,
  },
  hostBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  hostName: {
    fontSize: theme.fontSize.base,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  hostNameMuted: {
    color: theme.colors.foregroundMuted,
  },
  hostTrailing: {
    flexDirection: "row",
    alignItems: "center",
    height: 18,
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerGroup: {
    paddingVertical: theme.spacing[1],
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  actionLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
}));
