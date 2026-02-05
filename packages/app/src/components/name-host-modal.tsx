import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  field: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
}));

export interface NameHostModalProps {
  visible: boolean;
  serverId: string;
  hostname: string | null;
  onSkip: () => void;
  onSave: (label: string) => void;
}

export function NameHostModal({ visible, serverId, hostname, onSkip, onSave }: NameHostModalProps) {
  const { theme } = useUnistyles();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const InputComponent = useMemo(() => (isMobile ? BottomSheetTextInput : TextInput), [isMobile]);

  const [label, setLabel] = useState("");
  const hasEditedRef = useRef(false);

  const suggested = (hostname?.trim() || serverId).trim();

  useEffect(() => {
    if (!visible) return;
    setLabel(suggested);
    hasEditedRef.current = false;
  }, [suggested, visible]);

  useEffect(() => {
    if (!visible) return;
    if (hasEditedRef.current) return;
    if (!hostname) return;
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed === serverId) {
      setLabel(hostname.trim());
    }
  }, [hostname, label, serverId, visible]);

  const handleChange = useCallback((value: string) => {
    hasEditedRef.current = true;
    setLabel(value);
  }, []);

  const handleSave = useCallback(() => {
    const trimmed = label.trim();
    if (!trimmed) {
      onSkip();
      return;
    }
    onSave(trimmed);
  }, [label, onSave, onSkip]);

  return (
    <AdaptiveModalSheet title="Name this host" visible={visible} onClose={onSkip} testID="name-host-modal">
      <Text style={styles.helper}>
        Optional. You can rename this later in Settings.
      </Text>

      <View style={styles.field}>
        <Text style={styles.label}>Label</Text>
        <InputComponent
          value={label}
          onChangeText={handleChange}
          placeholder={suggested}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleSave}
        />
      </View>

      <View style={styles.actions}>
        <Button style={{ flex: 1 }} variant="secondary" onPress={onSkip} testID="name-host-skip">
          Skip
        </Button>
        <Button style={{ flex: 1 }} variant="default" onPress={handleSave} testID="name-host-save">
          Save
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
