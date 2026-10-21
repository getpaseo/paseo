import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { MenuItem } from "@/components/ui/menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  ToolbarLabelTriggerIcon,
  isToolbarLabelTriggerHighlighted,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
} from "@/components/ui/toolbar-label-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import { PluginIconView } from "@/plugins/icons";
import type { Theme } from "@/styles/theme";
import type { FilePanel } from "../panels";
import { useFilePanelChoiceSnapshot, type FilePanelChoice } from "./hook";
import { filePanelIcon, filePanelTitle } from "./presentation";
import { filePanelSwitcherState, type FilePanelSwitcherState } from "./switcher-layout";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedPanelIcon = withUnistyles(PluginIconView);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The file bar's panel switcher. Renders nothing unless the file has more than one panel. */
export function FilePanelSwitcher({ choice }: { choice: FilePanelChoice }) {
  const { openWith } = useFilePanelChoiceSnapshot(choice);
  const compact = useIsCompactFormFactor();
  const switcher = filePanelSwitcherState(openWith, { compact });
  const select = useCallback((panelId: string) => choice.openWith(panelId), [choice]);
  if (!switcher) return null;
  return switcher.layout === "segmented" ? (
    <SegmentedSwitcher switcher={switcher} onSelect={select} />
  ) : (
    <MenuSwitcher switcher={switcher} onSelect={select} />
  );
}

interface SwitcherProps {
  switcher: FilePanelSwitcherState<FilePanel>;
  onSelect(panelId: string): void;
}

function SegmentedSwitcher({ switcher, onSelect }: SwitcherProps) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      switcher.candidates.map((panel) => ({
        value: panel.id,
        label: filePanelTitle(t, panel),
        testID: `file-panel-switcher-${panel.id}`,
      })),
    [switcher.candidates, t],
  );
  return (
    <SegmentedControl
      size="xs"
      value={switcher.activePanelId}
      onValueChange={onSelect}
      options={options}
      testID="file-panel-switcher"
    />
  );
}

function MenuSwitcher({ switcher, onSelect }: SwitcherProps) {
  const { t } = useTranslation();
  const active = switcher.candidates.find((panel) => panel.id === switcher.activePanelId);
  const activeTitle = active ? filePanelTitle(t, active) : "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={toolbarLabelTriggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("panels.file.filePanels.openWith")}
        testID="file-panel-switcher"
      >
        {(state) => (
          <>
            <Text
              style={toolbarLabelTriggerTextStyle(isToolbarLabelTriggerHighlighted(state))}
              numberOfLines={1}
            >
              {activeTitle}
            </Text>
            <ToolbarLabelTriggerIcon>
              <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
            </ToolbarLabelTriggerIcon>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} testID="file-panel-switcher-menu">
        {switcher.candidates.map((panel) => (
          <SwitcherMenuItem
            key={panel.id}
            panel={panel}
            selected={panel.id === switcher.activePanelId}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SwitcherMenuItem({
  panel,
  selected,
  onSelect,
}: {
  panel: FilePanel;
  selected: boolean;
  onSelect(panelId: string): void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(panel.id), [onSelect, panel.id]);
  const leading = useMemo(
    () => <ThemedPanelIcon icon={filePanelIcon(panel)} size={16} uniProps={mutedIconMapping} />,
    [panel],
  );
  return (
    <MenuItem
      selected={selected}
      leading={leading}
      onSelect={handleSelect}
      testID={`file-panel-switcher-${panel.id}`}
    >
      {filePanelTitle(t, panel)}
    </MenuItem>
  );
}
