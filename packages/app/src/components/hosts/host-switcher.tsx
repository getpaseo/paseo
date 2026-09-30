import { ChevronDown } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { HostPicker } from "./host-picker";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface HostSwitcherHost {
  serverId: string;
  label: string;
}

/** A compact trigger showing the chosen host, opening the host picker to change it. */
export function HostSwitcher({
  hosts,
  value,
  onSelect,
  title,
  accessibilityLabel,
  testID,
}: {
  hosts: HostSwitcherHost[];
  value: string;
  onSelect: (serverId: string) => void;
  /** The picker's title. */
  title: string;
  /** Prefixes the selected host's label: "Plugin host: Laptop". */
  accessibilityLabel: string;
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View | null>(null);
  const selectedLabel = hosts.find((host) => host.serverId === value)?.label ?? value;
  const openPicker = useCallback(() => setOpen(true), []);
  return (
    <HostPicker
      hosts={hosts}
      value={value}
      onSelect={onSelect}
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      title={title}
      desktopPlacement="bottom-start"
    >
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${accessibilityLabel}: ${selectedLabel}`}
          testID={testID}
          onPress={openPicker}
          style={styles.trigger}
        >
          <Text numberOfLines={1} style={styles.label}>
            {selectedLabel}
          </Text>
          <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
    </HostPicker>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    maxWidth: 180,
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
