import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, type View } from "react-native";
import { ChevronDown, Folder } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Combobox } from "@/components/ui/combobox";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { ScheduleWorkspaceOption } from "@/schedules/schedule-project-targets";

const ThemedFolder = withUnistyles(Folder);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const ALL_WORKSPACES_OPTION_ID = "all-workspaces";

export interface WorkspaceFilterProps {
  options: ScheduleWorkspaceOption[];
  selected: string;
  onSelect: (id: string) => void;
  triggerTestID?: string;
}

/** The "All workspaces / <workspace>" pill beside the host filter on Schedules. */
export function WorkspaceFilter({
  options,
  selected,
  onSelect,
  triggerTestID,
}: WorkspaceFilterProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const selectedLabel = useMemo(
    () => options.find((option) => option.id === selected)?.label ?? "All workspaces",
    [options, selected],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setIsOpen(false);
    },
    [onSelect],
  );

  return (
    <Combobox
      options={[{ id: ALL_WORKSPACES_OPTION_ID, label: "All workspaces" }, ...options]}
      value={selected}
      onSelect={handleSelect}
      searchable={false}
      title="Filter by workspace"
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={anchorRef}
      desktopPlacement="bottom-start"
    >
      <PressHighlight
        ref={anchorRef}
        onPress={handleOpen}
        style={styles.filterTrigger}
        testID={triggerTestID}
        accessibilityRole="button"
        accessibilityLabel={`Filter: ${selectedLabel}`}
      >
        <ThemedFolder size={14} uniProps={mutedColorMapping} />
        <Text style={styles.filterTriggerText} numberOfLines={1}>
          {selectedLabel}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
      </PressHighlight>
    </Combobox>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  filterTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));
