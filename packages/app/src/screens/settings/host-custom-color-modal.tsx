import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import ColorPicker, { HueSlider, Panel1, type ColorFormatsObject } from "reanimated-color-picker";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  hostColorValue,
  isCustomHostColor,
  normalizeCustomHostColor,
  type CustomHostColor,
  type HostColor,
} from "@/hosts/appearance";
import { identityColor } from "@/styles/identity-colors";

const DEFAULT_CUSTOM_COLOR =
  `#${identityColor("teal").replace(/^#/, "")}` satisfies CustomHostColor;

interface HostCustomColorModalProps {
  visible: boolean;
  color: HostColor;
  onClose: () => void;
  onSubmit: (color: CustomHostColor) => Promise<void>;
}

function initialPickerColor(color: HostColor): CustomHostColor {
  return normalizeCustomHostColor(hostColorValue(color)) ?? DEFAULT_CUSTOM_COLOR;
}

export function HostCustomColorModal({
  visible,
  color,
  onClose,
  onSubmit,
}: HostCustomColorModalProps) {
  const { t } = useTranslation();
  const initialColor = initialPickerColor(color);
  const [draft, setDraft] = useState(initialColor.toUpperCase());
  const [pickerColor, setPickerColor] = useState<CustomHostColor>(initialColor);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.appearance.color.custom.title") }),
    [t],
  );

  useEffect(() => {
    if (!visible) return;
    setDraft(initialColor.toUpperCase());
    setPickerColor(initialColor);
    setError(null);
    setIsPending(false);
  }, [initialColor, visible]);

  const handlePickerChange = useCallback(({ hex }: ColorFormatsObject) => {
    const normalized = normalizeCustomHostColor(hex);
    if (!normalized) return;
    const displayValue = normalized.toUpperCase();
    setDraft(displayValue);
    setPickerColor(normalized);
    setError(null);
    inputRef.current?.replaceText(displayValue);
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setDraft(value);
    setError(null);
    const normalized = normalizeCustomHostColor(value);
    if (normalized) {
      setPickerColor(normalized);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isPending) return;
    const normalized = normalizeCustomHostColor(draft);
    if (!normalized) {
      setError(t("settings.host.appearance.color.custom.invalid"));
      return;
    }
    setIsPending(true);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error && submitError.message
          ? submitError.message
          : t("common.errors.unableToSave"),
      );
    } finally {
      setIsPending(false);
    }
  }, [draft, isPending, onClose, onSubmit, t]);

  const handleSubmitVoid = useCallback(() => void handleSubmit(), [handleSubmit]);
  const handleCancel = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);
  const normalizedDraft = normalizeCustomHostColor(draft);
  const isUnchanged = isCustomHostColor(color) && normalizedDraft === color;

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={handleCancel}
      desktopMaxWidth={440}
      testID="host-appearance-custom-color-modal"
    >
      <View style={styles.body}>
        <ColorPicker
          value={pickerColor}
          onChangeJS={handlePickerChange}
          boundedThumb
          thumbSize={24}
          sliderThickness={22}
          style={styles.picker}
        >
          <Panel1
            style={styles.panel}
            accessibilityLabel={t("settings.host.appearance.color.custom.panelAccessibility")}
          />
          <HueSlider
            style={styles.hueSlider}
            accessibilityLabel={t("settings.host.appearance.color.custom.hueAccessibility")}
          />
        </ColorPicker>

        <View style={styles.inputRow}>
          <View style={[styles.preview, { backgroundColor: pickerColor }]} />
          <AdaptiveTextInput
            ref={inputRef}
            initialValue={initialColor.toUpperCase()}
            resetKey={`${visible}-${initialColor}`}
            onChangeText={handleInputChange}
            onSubmitEditing={handleSubmitVoid}
            placeholder={DEFAULT_CUSTOM_COLOR.toUpperCase()}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isPending}
            maxLength={7}
            accessibilityLabel={t("settings.host.appearance.color.custom.hexAccessibility")}
            style={styles.input}
            testID="host-appearance-custom-color-input"
          />
        </View>

        {error ? (
          <Text style={styles.errorText} testID="host-appearance-custom-color-error">
            {error}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={isPending}
            testID="host-appearance-custom-color-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSubmitVoid}
            disabled={isPending || !normalizedDraft || isUnchanged}
            testID="host-appearance-custom-color-submit"
          >
            {isPending
              ? t("renameModal.saving")
              : t("settings.host.appearance.color.custom.submit")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  picker: {
    gap: theme.spacing[3],
  },
  panel: {
    height: 180,
    borderRadius: theme.borderRadius.lg,
  },
  hueSlider: {
    borderRadius: theme.borderRadius.md,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  preview: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
