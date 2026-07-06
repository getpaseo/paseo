import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { HostProfile } from "@/types/host-connection";
import type { Theme } from "@/styles/theme";
import {
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
  HostPicker,
  HostStatusDotSlot,
} from "@/components/hosts/host-picker";

const ThemedServer = withUnistyles(Server);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface HostFilterProps {
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  triggerTestID?: string;
}

/**
 * The "All hosts / <host>" filter pill shared by the History and Schedules
 * screens: an anchored HostPicker with `includeAllHost`, hidden by the caller
 * when only one host exists. Copies the History layout exactly.
 */
export function HostFilter({
  hosts,
  selectedHost,
  onSelectHost,
  triggerTestID,
}: HostFilterProps): ReactElement {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const selectedHostLabel = useMemo(
    () => getHostPickerLabel(hosts, selectedHost, { includeAllHost: true }),
    [hosts, selectedHost],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const filterTriggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.filterTrigger,
      Boolean(hovered) && styles.filterTriggerHovered,
      pressed && styles.filterTriggerPressed,
    ],
    [],
  );

  return (
    <HostPicker
      hosts={hosts}
      value={selectedHost}
      onSelect={onSelectHost}
      open={isFilterOpen}
      onOpenChange={setIsFilterOpen}
      anchorRef={filterAnchorRef}
      includeAllHost
      searchable={false}
      title="Filter by host"
      desktopPlacement="bottom-start"
    >
      <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
        <Pressable
          onPress={handleFilterOpen}
          style={filterTriggerStyle}
          testID={triggerTestID}
          accessibilityRole="button"
          accessibilityLabel={`Filter: ${selectedHostLabel}`}
        >
          {selectedHost === ALL_HOSTS_OPTION_ID ? (
            <ThemedServer size={14} uniProps={mutedColorMapping} />
          ) : (
            <HostStatusDotSlot serverId={selectedHost} />
          )}
          <Text style={styles.filterTriggerText} numberOfLines={1}>
            {selectedHostLabel}
          </Text>
          <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
    </HostPicker>
  );
}

const styles = StyleSheet.create((theme) => ({
  filterTriggerWrap: {
    alignSelf: "flex-start",
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
