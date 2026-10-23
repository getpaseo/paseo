import { useCallback, useEffect, useMemo, useRef } from "react";
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
  onChange: (patch: VoiceSettingsPatch) => void | Promise<unknown>;
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

function roundSpeed(value: number): number {
  return Math.round(value * 100) / 100;
}

function definedOnly(patch: VoiceSettingsPatch): VoiceSettingsPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export function VoiceSettingsForm({
  settings,
  capabilities,
  colors,
  onChange,
}: VoiceSettingsFormProps) {
  const styles = useFormStyles(colors);
  const latest = useRef(settings);
  const current = useRef(settings);
  const pending = useRef(0);
  current.current = settings;
  useEffect(() => {
    if (pending.current === 0) latest.current = settings;
  }, [settings]);
  const send = useCallback(
    (patch: VoiceSettingsPatch) => {
      latest.current = { ...latest.current, ...definedOnly(patch) };
      pending.current += 1;
      const settle = () => {
        pending.current -= 1;
        if (pending.current === 0) latest.current = current.current;
      };
      Promise.resolve(onChange(patch)).then(settle, settle);
    },
    [onChange],
  );
  const slower = useCallback(
    () => send({ speed: roundSpeed(Math.max(SPEED_MIN, latest.current.speed - SPEED_STEP)) }),
    [send],
  );
  const faster = useCallback(
    () => send({ speed: roundSpeed(Math.min(SPEED_MAX, latest.current.speed + SPEED_STEP)) }),
    [send],
  );
  const lower = useCallback(
    () => send({ pitch: Math.max(PITCH_MIN, latest.current.pitch - 1) }),
    [send],
  );
  const higher = useCallback(
    () => send({ pitch: Math.min(PITCH_MAX, latest.current.pitch + 1) }),
    [send],
  );
  const selectPreset = useCallback((name: string) => send({ preset: name }), [send]);
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
