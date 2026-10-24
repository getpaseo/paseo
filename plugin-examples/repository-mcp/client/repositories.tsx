import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useMutation } from "@tanstack/react-query";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { connection } from "../shared/connection";
import { repositories } from "../shared/repositories";

type ReadyConnection = Extract<SettingsState<typeof connection.schema>, { status: "ready" }>;
function Connection({
  settings,
  theme,
}: {
  settings: ReadyConnection;
  theme: PluginSurfaceProps["theme"];
}) {
  const [url, setUrl] = useState(settings.values.url);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const save = useCallback(() => {
    void settings.save({ url }, settings.revision);
  }, [settings, url]);
  return (
    <SettingsCard>
      <SettingsInput
        label="HTTP MCP URL"
        initialValue={url}
        onChangeText={setUrl}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsAction
        label="Connection configuration"
        actionLabel={settings.saving ? "Saving…" : "Save connection"}
        disabled={settings.saving}
        onPress={save}
      />
      <SettingsRow label="Saved connection">
        <Text style={style}>{settings.values.url || "Not configured"}</Text>
      </SettingsRow>
    </SettingsCard>
  );
}
export function Repositories({ theme }: PluginSurfaceProps) {
  const settings = useSettings(connection);
  const list = useRpc(repositories);
  const { mutate, isPending, data, error, isError } = useMutation({
    mutationFn: (mode: "normal" | "empty" | "failure") => list({ mode }),
  });
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const normal = useCallback(() => mutate("normal"), [mutate]);
  const empty = useCallback(() => mutate("empty"), [mutate]);
  const failure = useCallback(() => mutate("failure"), [mutate]);
  let output = "Choose a request";
  if (error) output = error.message;
  else if (data)
    output =
      data.error ??
      (data.repositories.map((repository) => repository.path).join("\n") || "No repositories");
  return (
    <SettingsSection title="Fictional repositories">
      {settings.status === "ready" ? (
        <Connection key={settings.revision} settings={settings} theme={theme} />
      ) : (
        <SettingsCard>
          <Text style={style}>
            {settings.status === "loading" ? "Loading connection…" : settings.error}
          </Text>
          <SettingsAction
            label="Reload connection"
            actionLabel="Retry connection"
            onPress={settings.reload}
          />
        </SettingsCard>
      )}
      <SettingsCard>
        <SettingsAction
          label="Repository list"
          actionLabel={isPending ? "Loading…" : "List repositories"}
          disabled={isPending}
          onPress={normal}
        />
        <SettingsAction
          label="Empty result example"
          actionLabel="Show empty result"
          disabled={isPending}
          onPress={empty}
        />
        <SettingsAction
          label="Business error example"
          actionLabel="Show business error"
          disabled={isPending}
          onPress={failure}
        />
        <SettingsRow label={data?.error ? "Service business error" : "Result"}>
          <Text accessibilityRole={error || data?.error ? "alert" : undefined} style={style}>
            {output}
          </Text>
        </SettingsRow>
        {isError || data?.error ? (
          <SettingsAction
            label="Retry request"
            actionLabel="Retry repositories"
            disabled={isPending}
            onPress={normal}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
