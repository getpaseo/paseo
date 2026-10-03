import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/preferences";

type Ready = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;
const automaticOptions = [
  { value: "recommended", label: "Follow the recommendation" },
  { value: "current", label: "Keep the current project" },
  { value: "wait", label: "Wait for my choice" },
] as const;

function Controls({ state, theme }: { state: Ready; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState(() => ({ values: state.values, revision: state.revision }));
  const [seconds, setSeconds] = useState(String(state.values.waitSeconds));
  const [error, setError] = useState<string | null>(null);
  const update = useCallback(
    (value: Partial<Ready["values"]>) =>
      setDraft((current) => ({ ...current, values: { ...current.values, ...value } })),
    [],
  );
  const changeEnabled = useCallback((enabled: boolean) => update({ enabled }), [update]);
  const changeSystemOne = useCallback(
    (useSystemOne: boolean) => update({ useSystemOne }),
    [update],
  );
  const changeUnanswered = useCallback(
    (unansweredAction: Ready["values"]["unansweredAction"]) => update({ unansweredAction }),
    [update],
  );
  const changeParent = useCallback(
    (newProjectParent: string) => update({ newProjectParent }),
    [update],
  );
  const changeHome = useCallback((daemonHome: string) => update({ daemonHome }), [update]);
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  const save = useCallback(async () => {
    const parsed = preferences.schema.safeParse({
      ...draft.values,
      waitSeconds:
        draft.values.unansweredAction === "wait" ? draft.values.waitSeconds : Number(seconds),
    });
    if (!parsed.success) {
      setError("Choose a whole number between 5 and 3600 seconds.");
      return;
    }
    setError(null);
    if (await state.save(parsed.data, draft.revision)) {
      await state.reload();
    }
  }, [state, draft, seconds]);
  const validSeconds = /^\d+$/.test(seconds) && Number(seconds) >= 5 && Number(seconds) <= 3600;
  return (
    <SettingsSection title="Project intake">
      <Text style={styles.muted}>
        Before Direct or Kitchen starts, compare the request with the selected project. A separate
        project gets its own folder and Git history.
      </Text>
      <SettingsCard>
        <SettingsSwitch
          label="Check the project before starting"
          value={draft.values.enabled}
          disabled={state.saving}
          onValueChange={changeEnabled}
        />
        <SettingsSwitch
          label="Use System One / Jev"
          value={draft.values.useSystemOne}
          disabled={state.saving}
          onValueChange={changeSystemOne}
        />
        <SettingsSelect
          label="If I leave the question untouched"
          value={draft.values.unansweredAction}
          options={automaticOptions}
          disabled={state.saving}
          onValueChange={changeUnanswered}
        />
        {draft.values.unansweredAction !== "wait" ? (
          <SettingsInput
            label="Wait time in seconds"
            initialValue={seconds}
            onChangeText={setSeconds}
            disabled={state.saving}
            error={!validSeconds ? "Enter 5–3600 seconds." : undefined}
          />
        ) : null}
        <SettingsInput
          label="Parent directory for new projects"
          hint="Leave empty to create beside the selected project's root."
          initialValue={draft.values.newProjectParent}
          onChangeText={changeParent}
          disabled={state.saving}
        />
        <SettingsInput
          label="Daemon home for System One"
          hint="Leave empty to use this host's PandaOS home. Credentials stay on the daemon."
          initialValue={draft.values.daemonHome}
          onChangeText={changeHome}
          disabled={state.saving}
        />
        <SettingsAction
          label="Apply project intake preferences"
          actionLabel="Save settings"
          disabled={state.saving || (draft.values.unansweredAction !== "wait" && !validSeconds)}
          onPress={save}
        />
      </SettingsCard>
      <Text style={styles.muted}>
        Jev has at most two seconds to decide. Low confidence or unavailable Jev keeps the current
        project as the automatic default. Interacting with the question stops its timer. Your
        selected provider, model and request are preserved.
      </Text>
      {error || state.saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error || state.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

export function ProjectIntakeSettings({ theme }: PluginSurfaceProps) {
  const state = useSettings(preferences);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (state.status === "loading") return <Text style={textStyle}>Loading project intake…</Text>;
  if (state.status !== "ready")
    return (
      <SettingsSection title="Project intake">
        <Text style={textStyle}>{state.error}</Text>
        <SettingsAction label="Load saved preferences" actionLabel="Retry" onPress={state.reload} />
      </SettingsSection>
    );
  return <Controls key={state.revision} state={state} theme={theme} />;
}
