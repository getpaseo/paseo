import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HOST_STATUS_DOT_SIZE } from "@/components/host-status-dot";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { mapLayout } from "@/components/ui/control-sizing";
import { density } from "@/styles/density";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
  HostPicker,
  HostStatusDotSlot,
  type HostPickerHost,
} from "@/components/hosts/host-picker";

const ThemedServer = withUnistyles(Server);
// The height a hung trigger keeps: one line of its base-size label.
const LABEL_LINE = 20;
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface HostFilterProps {
  hosts: HostPickerHost[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  /**
   * Offer "All hosts". Off for a surface that acts on exactly one host's data — the label
   * manager edits a single host's catalog, so "all" is not an answer it could carry out.
   */
  includeAllHost?: boolean;
  /**
   * Hang the trigger into the surrounding padding, for a trigger that leads a column such as a
   * modal body: its leading glyph's ink sits on the content rail and it adds only a label line to
   * the column, so the column's own gap sets the rhythm. The frame still grows outward on hover.
   */
  hang?: boolean;
  triggerTestID?: string;
  hostOptionTestID?: (serverId: string) => string;
}

/**
 * The "All hosts / <host>" host picker shared by History, Schedules, Usage, the label manager and
 * plugin screens: an anchored HostPicker, hidden by the caller when only one host exists. Without
 * `includeAllHost` it picks the one host a surface shows. Its trigger is the Settings host
 * trigger; a long host name truncates instead of pushing the row.
 */
export function HostFilter({
  hosts,
  selectedHost,
  onSelectHost,
  includeAllHost = true,
  hang = false,
  triggerTestID,
  hostOptionTestID,
}: HostFilterProps): ReactElement {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const selectedHostLabel = useMemo(
    () => getHostPickerLabel(hosts, selectedHost, { includeAllHost }),
    [hosts, includeAllHost, selectedHost],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);
  const showsAllHosts = selectedHost === ALL_HOSTS_OPTION_ID;
  const slotStyle = useMemo(
    () => [
      styles.triggerSlot,
      hang && styles.triggerSlotHang,
      hang && (showsAllHosts ? styles.glyphHang : styles.dotHang),
    ],
    [hang, showsAllHosts],
  );

  const triggerStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered: boolean }) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      pressed && styles.triggerPressed,
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
      includeAllHost={includeAllHost}
      searchable={false}
      title="Filter by host"
      desktopPlacement="bottom-start"
      hostOptionTestID={hostOptionTestID}
    >
      <View style={slotStyle}>
        <ComboboxTrigger
          ref={filterAnchorRef}
          onPress={handleFilterOpen}
          style={triggerStyle}
          testID={triggerTestID}
          accessibilityRole="button"
          accessibilityLabel={`Filter: ${selectedHostLabel}`}
        >
          {showsAllHosts ? (
            <ThemedServer size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          ) : (
            <HostStatusDotSlot serverId={selectedHost} />
          )}
          <Text style={styles.label} numberOfLines={1}>
            {selectedHostLabel}
          </Text>
        </ComboboxTrigger>
      </View>
    </HostPicker>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A row around the trigger keeps it as wide as its label in a column, and centred like any other
  // item in a row.
  triggerSlot: {
    flexDirection: "row",
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
  },
  // Hangs the frame's height down to a label line.
  triggerSlotHang: {
    marginVertical: mapLayout(density.tightRowHeight, (height) => (LABEL_LINE - height) / 2),
  },
  // Hangs the padding, so the server glyph's box sits on the rail.
  glyphHang: {
    marginLeft: -theme.spacing[2],
  },
  // Hangs the padding and the dot's inset in its icon slot, so the dot's ink sits on the rail.
  dotHang: {
    marginLeft: -(theme.spacing[2] + (ICON_SIZE.sm - HOST_STATUS_DOT_SIZE) / 2),
  },
  // The Settings host trigger: a borderless row that fills on hover and press.
  trigger: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
