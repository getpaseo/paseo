import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPlaybackRpc, getVoiceSettingsRpc, setVoiceSettingsRpc } from "../shared/voice-rpc";
import type { VoiceSettingsPatch } from "../shared/voice-settings";
import { VoiceSettingsForm } from "./voice-settings-form";
import { WordHighlight } from "./word-highlight";

const PLAYBACK_POLL_MS = 500;
const TICK_MS = 50;

function useElapsedSeconds(
  playback: { serverNow: number; startedAt: number } | null,
  receivedAt: number,
): number {
  const [now, setNow] = useState(receivedAt);
  useEffect(() => {
    if (!playback) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [playback]);
  if (!playback) return -1;
  return (playback.serverNow - playback.startedAt + Math.max(0, now - receivedAt)) / 1000;
}

export function VoicePanel({ theme, layout }: PluginWorkspacePanelProps) {
  const queryClient = useQueryClient();
  const getSettings = useRpc(getVoiceSettingsRpc);
  const setSettings = useRpc(setVoiceSettingsRpc);
  const getPlayback = useRpc(getPlaybackRpc);
  const settingsQuery = useQuery({
    queryKey: ["pyrgos-voice-settings"],
    queryFn: () => getSettings({}),
  });
  const playbackQuery = useQuery({
    queryKey: ["pyrgos-voice-playback"],
    queryFn: async () => ({ ...(await getPlayback({})), receivedAt: Date.now() }),
    refetchInterval: PLAYBACK_POLL_MS,
  });
  const save = useMutation({
    mutationFn: (patch: VoiceSettingsPatch) => setSettings(patch),
    onSuccess: (state) => queryClient.setQueryData(["pyrgos-voice-settings"], state),
  });

  const { mutateAsync } = save;
  const saveSettings = useCallback(
    (patch: VoiceSettingsPatch) => mutateAsync(patch),
    [mutateAsync],
  );

  const utterance = playbackQuery.data?.utterance ?? null;
  const timing = useMemo(
    () =>
      utterance && playbackQuery.data
        ? { serverNow: playbackQuery.data.serverNow, startedAt: utterance.startedAt }
        : null,
    [utterance, playbackQuery.data],
  );
  const elapsed = useElapsedSeconds(timing, playbackQuery.data?.receivedAt ?? 0);

  const colors = useMemo(
    () => ({
      surface: theme.colors.surface1,
      foreground: theme.colors.foreground,
      muted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
    }),
    [theme],
  );
  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        gap: 20,
        backgroundColor: theme.colors.surface0,
      },
      heading: { color: theme.colors.accent, fontSize: 13, fontWeight: "600" as const },
      idle: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
  const error = settingsQuery.error ?? save.error;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Voice</Text>
      {settingsQuery.data ? (
        <VoiceSettingsForm
          settings={settingsQuery.data.settings}
          capabilities={settingsQuery.data.capabilities}
          colors={colors}
          onChange={saveSettings}
        />
      ) : null}
      <Text style={styles.heading}>Now speaking</Text>
      {utterance ? (
        <WordHighlight words={utterance.words} elapsedSeconds={elapsed} colors={colors} />
      ) : (
        <Text style={styles.idle}>Nothing spoken yet.</Text>
      )}
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
    </View>
  );
}
