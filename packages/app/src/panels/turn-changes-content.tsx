import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { DiffState } from "@getpaseo/client";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useAppSettings } from "@/hooks/use-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { DiffDocument } from "@/git/diff-document";
import { resolveDiffLayout } from "@/git/diff-pane";

const commitMode = { kind: "commit" } as const;

export function TurnChangesContent({
  serverId,
  cwd,
  before,
  after,
}: {
  serverId: string;
  cwd: string;
  before: string;
  after: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<DiffState | null>(null);
  const { settings } = useAppSettings();
  const { preferences } = useChangesPreferences();
  const compact = useIsCompactFormFactor();
  const displayPreferences = useMemo(
    () => ({
      layout: resolveDiffLayout(preferences.layout, isWeb && !compact),
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [
      compact,
      preferences.layout,
      preferences.wrapLines,
      settings.codeFontSize,
      settings.monoFontFamily,
    ],
  );

  useEffect(() => {
    if (!client) return;
    setState(null);
    const subscription = client.observeDiff({
      cwd,
      base: { kind: "rev", rev: before },
      head: { kind: "rev", rev: after },
    });
    const unsubscribe = subscription.subscribe({
      snapshot: setState,
      update: () => {},
      error: (error) =>
        setState({
          phase: "error",
          revision: 0,
          error: { code: "UNKNOWN", message: String(error) },
        }),
    });
    return () => {
      unsubscribe();
      void subscription.release();
    };
  }, [after, before, client, cwd]);

  if (!state || state.phase === "loading")
    return <Text style={styles.message}>{t("workspace.tabs.loading")}</Text>;
  if (state.phase === "error") return <Text style={styles.message}>{state.error.message}</Text>;
  if (state.files.length === 0) return <Text style={styles.message}>{t("panels.diff.empty")}</Text>;
  return (
    <View style={styles.content} testID="turn-changes-content">
      <DiffDocument files={state.files} displayPreferences={displayPreferences} mode={commitMode} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minHeight: 0 },
  message: { color: theme.colors.foregroundMuted, padding: theme.spacing[4] },
}));
