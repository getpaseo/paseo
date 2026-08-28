import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import {
  ChevronDown,
  Maximize,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarButtonStyle } from "@/desktop/browser/chrome";
import {
  DEVICE_SIZE_PRESETS,
  formatDevicePresetLabel,
  isPresetLandscape,
  orientedSize,
  type DeviceSizeId,
  type DeviceSizePreset,
  type DeviceSizeSelection,
} from "@/desktop/browser/device-sizes";

const RESPONSIVE_DEVICE_LABEL_KEY = "workspace.browser.devices.responsive";
const LANDSCAPE_LABEL_KEY = "workspace.browser.devices.landscape";

// Lucide icons themed via withUnistyles so their color stays theme-reactive
// without a banned useUnistyles() call.
const ThemedMaximize = withUnistyles(Maximize);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedRotateCw = withUnistyles(RotateCw);
const deviceMutedIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

function resolveThemedDeviceIcon(icon: LucideIcon): typeof ThemedMaximize {
  if (icon === Smartphone) return ThemedSmartphone;
  if (icon === Tablet) return ThemedTablet;
  if (icon === Monitor) return ThemedMonitor;
  return ThemedMaximize;
}

function DeviceSizeMenuItem({
  preset,
  selected,
  isLandscape,
  responsiveLabel,
  onSelect,
}: {
  preset: DeviceSizePreset;
  selected: boolean;
  isLandscape: boolean;
  responsiveLabel: string;
  onSelect: (selection: DeviceSizeSelection) => void;
}) {
  const ThemedIcon = resolveThemedDeviceIcon(preset.icon);
  const size = useMemo(() => orientedSize(preset, isLandscape), [isLandscape, preset]);
  const label = formatDevicePresetLabel(preset, responsiveLabel, size);
  const handleSelect = useCallback(() => {
    onSelect({ id: preset.id, isLandscape, size });
  }, [isLandscape, onSelect, preset.id, size]);
  const leading = useMemo(
    () => <ThemedIcon size={16} uniProps={deviceMutedIconMapping} />,
    [ThemedIcon],
  );
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
      leading={leading}
    >
      {label}
    </DropdownMenuItem>
  );
}

/**
 * Viewport picker shared by the local webview pane and the mirrored pane. The
 * caller owns what a preset means: the local pane resizes its own webview, the
 * mirror sends a `resize` command to the host that owns the tab.
 */
export function DeviceSizeMenu({
  selectedId,
  isLandscape,
  onSelect,
}: {
  selectedId: DeviceSizeId | null;
  isLandscape: boolean;
  onSelect: (selection: DeviceSizeSelection) => void;
}) {
  const { t } = useTranslation();
  const selectedPreset =
    DEVICE_SIZE_PRESETS.find((preset) => preset.id === selectedId) ?? DEVICE_SIZE_PRESETS[0];
  const SelectedIcon = resolveThemedDeviceIcon(selectedPreset.icon);
  const label = t("workspace.browser.devices.label");
  const responsiveLabel = t(RESPONSIVE_DEVICE_LABEL_KEY);
  // "Responsive" fills the pane it is shown in, so it has no orientation of its
  // own and the row would do nothing.
  const canRotate = selectedPreset.id !== "responsive";
  const orientationIcon = useMemo(
    () => <ThemedRotateCw size={16} uniProps={deviceMutedIconMapping} />,
    [],
  );
  const toggleOrientation = useCallback(() => {
    onSelect({
      id: selectedPreset.id,
      isLandscape: !isLandscape,
      size: orientedSize(selectedPreset, !isLandscape),
    });
  }, [isLandscape, onSelect, selectedPreset]);
  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger accessibilityLabel={label} style={toolbarButtonStyle}>
            <View style={styles.deviceTrigger}>
              <SelectedIcon size={16} uniProps={deviceMutedIconMapping} />
              <ThemedChevronDown size={12} uniProps={deviceMutedIconMapping} />
            </View>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.toolbarTooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {canRotate ? (
          <>
            <DropdownMenuItem
              onSelect={toggleOrientation}
              selected={isLandscape}
              showSelectedCheck
              leading={orientationIcon}
            >
              {t(LANDSCAPE_LABEL_KEY)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {DEVICE_SIZE_PRESETS.map((preset) => (
          <DeviceSizeMenuItem
            key={preset.id}
            preset={preset}
            selected={preset.id === selectedId}
            isLandscape={preset.id === selectedId ? isLandscape : isPresetLandscape(preset)}
            responsiveLabel={responsiveLabel}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  deviceTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toolbarTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
