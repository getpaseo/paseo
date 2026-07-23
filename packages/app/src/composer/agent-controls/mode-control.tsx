import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { formatAgentModeLabel, getAgentControlHintKey } from "@/composer/agent-controls/utils";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { resolveNextAgentModeId } from "@/composer/agent-controls/mode";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { getAgentModeIcon } from "./icons";
interface ModeComboboxOptionProps {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  iconColor: string;
}

function ModeComboboxOption({
  option,
  selected,
  active,
  onPress,
  provider,
  providerDefinitions,
  iconColor,
}: ModeComboboxOptionProps) {
  const IconComponent = getAgentModeIcon(provider, option.id, providerDefinitions);
  const leadingSlot = useMemo(
    () => <IconComponent size={16} color={iconColor} />,
    [IconComponent, iconColor],
  );
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

export interface AgentModeControlValue {
  provider: string;
  providerDefinitions: AgentProviderDefinition[];
  modeOptions: AgentMode[];
  selectedModeId: string | null | undefined;
  onSelectMode: (modeId: string) => void;
  disabled?: boolean;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function AgentModeControl({
  provider,
  providerDefinitions,
  modeOptions,
  selectedModeId,
  onSelectMode,
  disabled = false,
  surface = "toolbar",
  onClose,
}: AgentModeControlValue & { surface?: "toolbar" | "sheet"; onClose?: () => void }) {
  const { theme } = useUnistyles();
  const { presentation } = useComposerControlLayout();
  const { t } = useTranslation();
  const { isActiveComposer } = useComposerKeyboardScope();
  const cycleShortcutKeys = useShortcutKeys("cycle-agent-mode");
  const anchorRef = useRef<View>(null);
  const keyboardHandlerIdRef = useRef(`mode-control:${Math.random().toString(36).slice(2)}`);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const selectedMode = useMemo(() => {
    if (modeOptions.length === 0) return null;
    return modeOptions.find((m) => m.id === selectedModeId) ?? modeOptions[0];
  }, [modeOptions, selectedModeId]);

  const Icon = getAgentModeIcon(provider, selectedMode?.id ?? "", providerDefinitions);
  const iconColor = theme.colors.foregroundMuted;
  const selectedModeLabel = selectedMode ? formatAgentModeLabel(selectedMode) : "";

  const allOptions = useMemo<ComboboxOption[]>(
    () => modeOptions.map((m) => ({ id: m.id, label: formatAgentModeLabel(m) })),
    [modeOptions],
  );
  const options = useMemo<ComboboxOption[]>(() => {
    const q = normalizeSearchQuery(searchQuery);
    if (!q) return allOptions;
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, searchQuery]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      const wasOpen = openRef.current;
      openRef.current = next;
      setOpen(next);
      if (!next) {
        setSearchQuery("");
        if (wasOpen) onClose?.();
      }
    },
    [onClose],
  );

  const handlePress = useCallback(() => handleOpenChange(!open), [handleOpenChange, open]);
  const handleSelect = useCallback(
    (id: string) => {
      onSelectMode(id);
      handleOpenChange(false);
    },
    [onSelectMode, handleOpenChange],
  );

  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id !== "message-input.mode-cycle") return false;
      if (disabled || !isActiveComposer) return false;
      const nextModeId = resolveNextAgentModeId({ modeOptions, selectedMode: selectedModeId });
      if (!nextModeId) return false;
      onSelectMode(nextModeId);
      return true;
    },
    [disabled, isActiveComposer, modeOptions, onSelectMode, selectedModeId],
  );

  useKeyboardActionHandler({
    handlerId: keyboardHandlerIdRef.current,
    actions: ["message-input.mode-cycle"],
    enabled: isActiveComposer && !disabled && modeOptions.length > 1,
    priority: 200,
    handle: handleKeyboardAction,
  });

  const renderOption = useCallback(
    (args: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }): ReactElement => (
      <ModeComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        provider={provider}
        providerDefinitions={providerDefinitions}
        iconColor={theme.colors.foreground}
      />
    ),
    [provider, providerDefinitions, theme.colors.foreground],
  );

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: t("agentControls.mode.title"),
      search: {
        onChange: setSearchQuery,
        placeholder: t("agentControls.mode.searchPlaceholder"),
        testID: "mode-search-input",
      },
    }),
    [t],
  );

  if (!selectedMode) return null;

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={Icon}
            iconColor={iconColor}
            surface={surface}
            label={t("agentControls.mode.title")}
            value={selectedModeLabel}
            showToolbarLabel={presentation.showModeLabel}
            showCaret={surface === "toolbar" && presentation.showCarets}
            open={open}
            disabled={disabled}
            onPress={handlePress}
            accessibilityLabel={t("agentControls.mode.selectWithValue", {
              value: selectedModeLabel,
            })}
            testID="mode-control"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <View style={styles.tooltipRow}>
            <Text style={styles.tooltipText}>{t(getAgentControlHintKey("mode"))}</Text>
            {isActiveComposer && cycleShortcutKeys ? <Shortcut chord={cycleShortcutKeys} /> : null}
          </View>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={selectedMode.id}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={260}
        header={sheetHeader}
        renderOption={renderOption}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
