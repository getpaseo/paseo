import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/preferences";

const grouping = [
  { label: "Project", value: "project" },
  { label: "Workspace", value: "workspace" },
  { label: "None", value: "none" },
] as const;
type Preferences = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;

function TitleEditor({ settings, onClose }: { settings: Preferences; onClose(): void }) {
  // Keep the draft's revision so another client's save produces a conflict.
  const [draft, setDraft] = useState(() => ({
    values: settings.values,
    revision: settings.revision,
  }));
  const changeTitle = useCallback(
    (title: string) =>
      setDraft((current) => ({ ...current, values: { ...current.values, title } })),
    [],
  );
  const saveTitle = useCallback(async () => {
    if (await settings.save(draft.values, draft.revision)) onClose();
  }, [settings, draft, onClose]);
  return (
    <SettingsCard>
      <SettingsInput
        label="Monitor title"
        initialValue={draft.values.title}
        onChangeText={changeTitle}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsAction
        label="Title changes"
        actionLabel="Save title"
        disabled={settings.saving}
        onPress={saveTitle}
      />
      <SettingsAction
        label="Discard title changes"
        actionLabel="Discard"
        disabled={settings.saving}
        onPress={onClose}
      />
    </SettingsCard>
  );
}

function DisplayControls({
  settings,
  theme,
}: {
  settings: Preferences;
  theme: PluginSurfaceProps["theme"];
}) {
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const [editingTitle, setEditingTitle] = useState(false);
  const closeTitle = useCallback(() => {
    setEditingTitle(false);
    void settings.reload();
  }, [settings]);
  const toggleTitle = useCallback(() => setEditingTitle((value) => !value), []);
  const changeGrouping = useCallback(
    (groupBy: Preferences["values"]["groupBy"]) => {
      void settings.save({ ...settings.values, groupBy }, settings.revision);
    },
    [settings],
  );
  const changeMetadata = useCallback(
    (showMetadata: boolean) => {
      void settings.save({ ...settings.values, showMetadata }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title="Display">
      <SettingsCard>
        <SettingsSelect
          label="Group agents by"
          value={settings.values.groupBy}
          options={grouping}
          disabled={settings.saving}
          onValueChange={changeGrouping}
        />
        <SettingsSwitch
          label="Show metadata"
          value={settings.values.showMetadata}
          disabled={settings.saving}
          onValueChange={changeMetadata}
        />
        <SettingsAction
          label="Monitor title"
          actionLabel={editingTitle ? "Close editor" : "Edit title"}
          disabled={settings.saving}
          onPress={toggleTitle}
        />
      </SettingsCard>
      {editingTitle ? <TitleEditor settings={settings} onClose={closeTitle} /> : null}
      {settings.saveError && !editingTitle ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsRow label="Preview">
        <View>
          <Text style={style}>{settings.values.title}</Text>
          <Text style={style}>Grouped by {settings.values.groupBy}</Text>
          <Text style={style}>
            {settings.values.showMetadata ? "Metadata visible" : "Metadata hidden"}
          </Text>
        </View>
      </SettingsRow>
    </SettingsSection>
  );
}

export function DisplaySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Display">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  return <DisplayControls settings={settings} theme={theme} />;
}
