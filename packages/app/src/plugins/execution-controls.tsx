import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Combobox } from "@/components/ui/combobox";
import type { PluginExecutionPresetCatalog } from "@getpaseo/plugin/client";
import type { InstalledExecutionMode } from "./execution";

export function ExecutionControls({
  modes,
  executionId,
  onExecutionChange,
  catalog,
  presetId,
  onPresetChange,
  loading,
  error,
  disabled,
  onManage,
}: {
  modes: readonly InstalledExecutionMode[];
  executionId: string;
  onExecutionChange(id: string): void;
  catalog: PluginExecutionPresetCatalog | null;
  presetId: string;
  onPresetChange(id: string): void;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onManage?: () => void;
}) {
  const modeAnchor = useRef<View>(null);
  const presetAnchor = useRef<View>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const openModes = useCallback(() => setModeOpen(true), []);
  const openPresets = useCallback(() => setPresetOpen(true), []);
  const selectedMode = modes.find((mode) => mode.id === executionId);
  const selectedPreset = catalog?.presets.find((preset) => preset.id === presetId);
  const unavailable = presetProblem(error, catalog, selectedPreset);
  const presetTitle = formatPresetTitle(loading, selectedPreset?.title, presetId);
  return (
    <View style={styles.container}>
      <View ref={modeAnchor} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Execution mode"
          disabled={disabled}
          onPress={openModes}
          style={styles.trigger}
        >
          <Text style={styles.label}>
            {executionId ? (selectedMode?.contribution.title ?? "Unavailable mode") : "Direct"}
          </Text>
        </Pressable>
        <Combobox
          anchorRef={modeAnchor}
          options={[
            { id: "", label: "Direct" },
            ...modes.map((mode) => ({ id: mode.id, label: mode.contribution.title })),
          ]}
          value={executionId}
          onSelect={onExecutionChange}
          open={modeOpen}
          onOpenChange={setModeOpen}
          title="Execution mode"
        />
      </View>
      {executionId ? (
        <View ref={presetAnchor} collapsable={false}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Team preset"
            disabled={disabled || loading || !catalog}
            onPress={openPresets}
            style={styles.trigger}
          >
            <Text style={styles.label}>{presetTitle}</Text>
          </Pressable>
          <Combobox
            anchorRef={presetAnchor}
            options={(catalog?.presets ?? [])
              .filter((preset) => !preset.unavailableReason)
              .map((preset) => ({
                id: preset.id,
                label: preset.title,
                description: [preset.group, preset.description].filter(Boolean).join(" · "),
              }))}
            value={presetId}
            onSelect={onPresetChange}
            open={presetOpen}
            onOpenChange={setPresetOpen}
            title="Team preset"
            searchable
          />
        </View>
      ) : null}
      {executionId && onManage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage teams"
          disabled={disabled}
          onPress={onManage}
          style={styles.trigger}
        >
          <Text style={styles.label}>Manage teams</Text>
        </Pressable>
      ) : null}
      {unavailable ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {unavailable}
        </Text>
      ) : null}
    </View>
  );
}

function formatPresetTitle(loading: boolean, title: string | undefined, presetId: string) {
  if (loading) return "Loading teams…";
  return title ?? (presetId ? "Unavailable team" : "Choose team");
}

function presetProblem(
  error: string | null,
  catalog: PluginExecutionPresetCatalog | null,
  preset: PluginExecutionPresetCatalog["presets"][number] | undefined,
) {
  return error ?? preset?.unavailableReason ?? (preset ? undefined : catalog?.unavailableReason);
}

const styles = StyleSheet.create((theme) => ({
  container: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  trigger: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface1,
  },
  label: { color: theme.colors.foreground, fontSize: 13 },
  error: { color: theme.colors.foregroundMuted, fontSize: 12, maxWidth: 320 },
}));
