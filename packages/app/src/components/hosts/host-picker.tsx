import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { GestureResponderEvent } from "react-native";
import { Plus, Server, Settings } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { orderHostsLocalFirst } from "@/types/host-connection";
import {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
} from "./host-picker-constants";

export { ADD_HOST_OPTION_ID, ALL_HOSTS_OPTION_ID, getHostPickerLabel };

const SEARCHABLE_THRESHOLD = 10;
type RenderHostOption = NonNullable<ComboboxProps["renderOption"]>;
interface HostPickerHost {
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
  isLocal: boolean;
  selected?: boolean;
  active: boolean;
  onPress: () => void;
  onOpenHostSettings?: (serverId: string) => void;
  localMarkerTestID?: string;
  testID?: string;
}

export function HostPickerOption({
  serverId,
  label,
  isLocal,
  selected,
  active,
  onPress,
  onOpenHostSettings,
  localMarkerTestID,
  testID,
}: HostPickerOptionProps): ReactElement {
  const { theme } = useUnistyles();
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={serverId} />, [serverId]);
  const handleSettingsPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenHostSettings?.(serverId);
    },
    [onOpenHostSettings, serverId],
  );
  const trailingSlot = useMemo(() => {
    if (!isLocal && !onOpenHostSettings) return undefined;
    return (
      <>
        {isLocal ? (
          <Text style={styles.localMarker} testID={localMarkerTestID}>
            Local
          </Text>
        ) : null}
        {onOpenHostSettings ? (
          <Pressable
            onPress={handleSettingsPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Open ${label} settings`}
          >
            <Settings size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </>
    );
  }, [
    handleSettingsPress,
    isLocal,
    label,
    localMarkerTestID,
    onOpenHostSettings,
    theme.colors.foregroundMuted,
    theme.iconSize.sm,
  ]);

  return (
    <ComboboxItem
      label={label}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      selected={selected}
      active={active}
      onPress={onPress}
      testID={testID}
    />
  );
}

function SystemHostPickerOption({
  active,
  selected,
  onPress,
  kind,
  testID,
}: {
  active: boolean;
  selected?: boolean;
  onPress: () => void;
  kind: "add" | "all";
  testID?: string;
}): ReactElement {
  const { theme } = useUnistyles();
  const Icon = kind === "add" ? Plus : Server;
  const label = kind === "add" ? "Add host" : "All hosts";
  const leadingSlot = useMemo(
    () => <Icon size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [Icon, theme.colors.foregroundMuted, theme.iconSize.sm],
  );

  return (
    <ComboboxItem
      label={label}
      leadingSlot={leadingSlot}
      selected={selected}
      active={active}
      onPress={onPress}
      testID={testID}
    />
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
  showLocalMarker?: boolean;
  onOpenHostSettings?: (serverId: string) => void;
  searchable?: boolean;
  title?: string;
  desktopPlacement?: "top-start" | "bottom-start";
  desktopMinWidth?: number;
  addHostTestID?: string;
  hostOptionTestID?: (serverId: string) => string;
  hostLocalMarkerTestID?: (serverId: string) => string;
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
  showLocalMarker,
  onOpenHostSettings,
  searchable,
  title,
  desktopPlacement = "top-start",
  desktopMinWidth,
  addHostTestID,
  hostOptionTestID,
  hostLocalMarkerTestID,
  children,
}: HostPickerProps): ReactElement {
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );

  const options = useMemo(() => {
    const hostOptions = orderedHosts.map((host) => ({ id: host.serverId, label: host.label }));
    if (includeAllHost) hostOptions.unshift({ id: ALL_HOSTS_OPTION_ID, label: "All hosts" });
    if (includeAddHost) hostOptions.push({ id: ADD_HOST_OPTION_ID, label: "Add host" });
    return hostOptions;
  }, [orderedHosts, includeAllHost, includeAddHost]);

  const isSearchable = searchable === true && orderedHosts.length > SEARCHABLE_THRESHOLD;

  const handleSelect = useCallback(
    (id: string) => {
      if (id === ADD_HOST_OPTION_ID) {
        onAddHost?.();
      } else {
        onSelect(id);
      }
      onOpenChange(false);
    },
    [onAddHost, onOpenChange, onSelect],
  );

  const handleOpenHostSettings = useCallback(
    (serverId: string) => {
      onOpenHostSettings?.(serverId);
      onOpenChange(false);
    },
    [onOpenHostSettings, onOpenChange],
  );

  const renderOption = useCallback<RenderHostOption>(
    ({ option, selected, active, onPress }) => {
      if (option.id === ADD_HOST_OPTION_ID) {
        return (
          <SystemHostPickerOption
            kind="add"
            active={active}
            onPress={onPress}
            testID={addHostTestID}
          />
        );
      }
      if (option.id === ALL_HOSTS_OPTION_ID) {
        return (
          <SystemHostPickerOption
            kind="all"
            active={active}
            selected={selected}
            onPress={onPress}
          />
        );
      }
      return (
        <HostPickerOption
          serverId={option.id}
          label={option.label}
          isLocal={showLocalMarker === true && localServerId === option.id}
          selected={selected}
          active={active}
          onPress={onPress}
          onOpenHostSettings={onOpenHostSettings ? handleOpenHostSettings : undefined}
          localMarkerTestID={hostLocalMarkerTestID?.(option.id)}
          testID={hostOptionTestID?.(option.id)}
        />
      );
    },
    [
      addHostTestID,
      hostLocalMarkerTestID,
      hostOptionTestID,
      localServerId,
      onOpenHostSettings,
      showLocalMarker,
      handleOpenHostSettings,
    ],
  );

  return (
    <>
      {children}
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        renderOption={renderOption}
        searchable={isSearchable}
        searchPlaceholder="Search hosts"
        title={title ?? "Host"}
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
  localMarker: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginLeft: theme.spacing[1],
  },
}));
