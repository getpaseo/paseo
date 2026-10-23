import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  PITCH_MAX,
  PITCH_MIN,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  type VoiceCapabilities,
  type VoiceSettings,
  type VoiceSettingsPatch,
} from "../shared/voice-settings";
import type { WordHighlightColors } from "./word-highlight";

export interface VoiceSettingsFormProps {
  settings: VoiceSettings;
  capabilities: VoiceCapabilities;
  colors: WordHighlightColors & { surface: string };
  onChange: (patch: VoiceSettingsPatch) => void;
}

interface StepperProps {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  disabled: boolean;
  styles: ReturnType<typeof useFormStyles>;
}

function useFormStyles(colors: VoiceSettingsFormProps["colors"]) {
  return useMemo(
    () => ({
      root: { gap: 12 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      label: { color: colors.foreground, width: 72 },
      value: { color: colors.foreground, minWidth: 56, textAlign: "center" as const },
      button: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: colors.surface,
      },
      buttonText: { color: colors.accent, fontSize: 16 },
      note: { color: colors.muted, fontSize: 12 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    }),
    [colors],
  );
}

function Stepper({ label, value, onMinus, onPlus, disabled, styles }: StepperProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label}`}
        disabled={disabled}
        onPress={onMinus}
        style={styles.button}
      >
        <Text style={styles.buttonText}>−</Text>
      </Pressable>
      <Text testID={`voice-${label.toLowerCase()}`} style={styles.value}>
        {disabled ? "n/a" : value}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label}`}
        disabled={disabled}
        onPress={onPlus}
        style={styles.button}
      >
        <Text style={styles.buttonText}>+</Text>
      </Pressable>
    </View>
  );
}

interface PresetChipProps {
  name: string;
  selected: boolean;
  onSelect: (name: string) => void;
  styles: ReturnType<typeof useFormStyles>;
}

function PresetChip({ name, selected, onSelect, styles }: PresetChipProps) {
  const press = useCallback(() => onSelect(name), [onSelect, name]);
  return (
    <Pressable accessibilityRole="button" onPress={press} style={styles.button}>
      <Text style={styles.buttonText}>{selected ? `● ${name}` : name}</Text>
    </Pressable>
  );
}

export function VoiceSettingsForm({
  settings,
  capabilities,
  colors,
  onChange,
}: VoiceSettingsFormProps) {
  const styles = useFormStyles(colors);
  const slower = useCallback(
    () => onChange({ speed: Math.max(SPEED_MIN, settings.speed - SPEED_STEP) }),
    [onChange, settings.speed],
  );
  const faster = useCallback(
    () => onChange({ speed: Math.min(SPEED_MAX, settings.speed + SPEED_STEP) }),
    [onChange, settings.speed],
  );
  const lower = useCallback(
    () => onChange({ pitch: Math.max(PITCH_MIN, settings.pitch - 1) }),
    [onChange, settings.pitch],
  );
  const higher = useCallback(
    () => onChange({ pitch: Math.min(PITCH_MAX, settings.pitch + 1) }),
    [onChange, settings.pitch],
  );
  const selectPreset = useCallback((name: string) => onChange({ preset: name }), [onChange]);
  return (
    <View testID="voice-settings" style={styles.root}>
      <Stepper
        label="Speed"
        value={`${settings.speed.toFixed(1)}x`}
        disabled={!capabilities.speed}
        styles={styles}
        onMinus={slower}
        onPlus={faster}
      />
      <Stepper
        label="Pitch"
        value={`${settings.pitch > 0 ? "+" : ""}${settings.pitch}`}
        disabled={!capabilities.pitch}
        styles={styles}
        onMinus={lower}
        onPlus={higher}
      />
      {capabilities.presets.length > 0 ? (
        <View style={styles.chips}>
          {capabilities.presets.map((name) => (
            <PresetChip
              key={name}
              name={name}
              selected={name === settings.preset}
              onSelect={selectPreset}
              styles={styles}
            />
          ))}
        </View>
      ) : null}
      {!capabilities.pitch || capabilities.presets.length === 0 ? (
        <Text style={styles.note}>Controls the provider does not support are disabled.</Text>
      ) : null}
    </View>
  );
}
