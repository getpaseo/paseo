import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import { useAssistants } from "@/hooks/use-assistants";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const ThemedBot = withUnistyles(Bot);

const botColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface AssistantSelectorProps {
  serverId: string;
  selectedAssistantId: string | null;
  onSelect: (assistantId: string | null) => void;
  disabled?: boolean;
}

const NO_ASSISTANT_ID = "__none__";

export function AssistantSelector({
  serverId,
  selectedAssistantId,
  onSelect,
  disabled,
}: AssistantSelectorProps): ReactElement | null {
  const assistants = useAssistants(serverId, { enabled: true });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View>(null);

  // Keep latest onSelect in a ref so handleSelect always calls the current one,
  // avoiding stale closures when the Combobox Modal re-renders.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const options = useMemo<ComboboxOption[]>(() => {
    const list: ComboboxOption[] = [{ id: NO_ASSISTANT_ID, label: "No assistant" }];
    for (const a of assistants.assistants) {
      list.push({
        id: a.id,
        label: a.name || "Unnamed assistant",
        description: a.description || undefined,
      });
    }
    return list;
  }, [assistants.assistants]);

  const selectedDisplay = useMemo(() => {
    if (!selectedAssistantId) return null;
    const a = assistants.assistants.find((x) => x.id === selectedAssistantId);
    return a ? a.name || "Unnamed assistant" : null;
  }, [assistants.assistants, selectedAssistantId]);

  const handleSelect = useCallback((id: string) => {
    if (id === NO_ASSISTANT_ID) {
      onSelectRef.current(null);
    } else {
      onSelectRef.current(id);
    }
    setOpen(false);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
  }, []);

  const handlePress = useCallback(() => setOpen((prev) => !prev), []);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      (pressed || open) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [open, disabled],
  );

  if (!assistants.isLoading && !assistants.isConnected && assistants.assistants.length === 0) {
    return null;
  }

  const label = selectedDisplay ?? "Assistant";
  const comboboxValue = selectedAssistantId ?? NO_ASSISTANT_ID;

  return (
    <>
      <ComboboxTrigger
        ref={triggerRef}
        collapsable={false}
        disabled={disabled}
        onPress={handlePress}
        style={pressableStyle}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <ThemedBot size={ICON_SIZE.sm} uniProps={botColorMapping} />
        <Text style={selectedDisplay ? styles.labelActive : styles.label} numberOfLines={1}>
          {label}
        </Text>
      </ComboboxTrigger>
      <Combobox
        options={options}
        value={comboboxValue}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={triggerRef}
        desktopPlacement="top-start"
        searchable={false}
      />
    </>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  trigger: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 1,
  },
  labelActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
}));
