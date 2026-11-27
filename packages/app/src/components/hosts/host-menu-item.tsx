import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { HostStatusDot } from "@/components/host-status-dot";
import { MenuItem } from "@/components/ui/menu";

interface HostMenuItemProps {
  serverId: string;
  label: string;
  selected: boolean;
  onSelect: (serverId: string) => void;
  /** Off for a multi-select page, where choosing a host is one of several toggles. */
  closeOnSelect?: boolean;
  testID?: string;
  statusTestID?: string;
}

/** A host as a menu option: its live status dot leads, and the chosen host carries the check. */
export function HostMenuItem({
  serverId,
  label,
  selected,
  onSelect,
  closeOnSelect = true,
  testID,
  statusTestID,
}: HostMenuItemProps): ReactElement {
  const handleSelect = useCallback(() => onSelect(serverId), [onSelect, serverId]);
  const leading = useMemo(
    () => (
      <View testID={statusTestID}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId, statusTestID],
  );
  return (
    <MenuItem
      selected={selected}
      closeOnSelect={closeOnSelect}
      leading={leading}
      onSelect={handleSelect}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}
