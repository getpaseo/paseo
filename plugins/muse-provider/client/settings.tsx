import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useSettings, type PluginScreenProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { museSettings } from "../shared/settings.js";

const networks = [
  { label: "Proxy only", value: "proxy-only" },
  { label: "Restricted", value: "restricted" },
  { label: "Enabled", value: "enabled" },
] as const;
type ReadySettings = Extract<SettingsState<typeof museSettings.schema>, { status: "ready" }>;

function Controls({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginScreenProps["theme"];
}) {
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const changeSandbox = useCallback(
    (sandbox: boolean) => {
      void settings.save({ ...settings.values, sandbox }, settings.revision);
    },
    [settings],
  );
  const changeNetwork = useCallback(
    (network: ReadySettings["values"]["network"]) => {
      void settings.save({ ...settings.values, network }, settings.revision);
    },
    [settings],
  );
  const changeTrust = useCallback(
    (trustWorkspace: boolean) => {
      void settings.save({ ...settings.values, trustWorkspace }, settings.revision);
    },
    [settings],
  );
  return (
    <SettingsSection title="Muse Code">
      <SettingsCard>
        <SettingsSwitch
          label="Sandbox"
          value={settings.values.sandbox}
          disabled={settings.saving}
          onValueChange={changeSandbox}
        />
        <SettingsSelect
          label="Network"
          value={settings.values.network}
          options={networks}
          disabled={settings.saving || !settings.values.sandbox}
          onValueChange={changeNetwork}
        />
        <SettingsSwitch
          label="Trust workspace"
          value={settings.values.trustWorkspace}
          disabled={settings.saving}
          onValueChange={changeTrust}
        />
      </SettingsCard>
      <Text style={style}>
        Changes apply to new Muse sessions. Disabling the sandbox enables full network access. Trust
        workspace lets Muse load project skills and configuration.
      </Text>
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

export function MuseSettings({ theme }: PluginScreenProps) {
  const settings = useSettings(museSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Muse Code">
        <Text accessibilityRole="alert" style={style}>
          {settings.error}
        </Text>
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
  return <Controls settings={settings} theme={theme} />;
}
