import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import * as Clipboard from "expo-clipboard";
import { Copy, RefreshCcw, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useToast } from "@/contexts/toast-api-context";
import {
  getDictationRecordingStore,
  type DictationRecording,
  type DictationRecordingOutcome,
} from "@/dictation/recordings";
import { transcribeRecording } from "@/dictation/recordings/transcribe-recording";
import { useDictationRecordings } from "@/dictation/recordings/use-dictation-recordings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const ThemedCopy = withUnistyles(Copy);
const ThemedTrash = withUnistyles(Trash2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const PREVIEW_LENGTH = 140;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeLabel(t: TFunction, outcome: DictationRecordingOutcome): string {
  switch (outcome.kind) {
    case "transcribed":
      return outcome.text.length > PREVIEW_LENGTH
        ? `${outcome.text.slice(0, PREVIEW_LENGTH).trimEnd()}…`
        : outcome.text;
    case "pending":
      return t("settings.voice.recordings.pending");
    case "failed":
      return t("message.dictation.failed", { error: outcome.error });
    case "empty":
      switch (outcome.reason) {
        case "no-audio":
          return t("message.dictation.empty.noAudio");
        case "silent-audio":
          return t("message.dictation.empty.silentAudio");
        case "no-speech":
          return t("message.dictation.empty.noSpeech");
      }
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Dictations kept on this device, so a failed or empty transcription can be
 * sent again to this host instead of being spoken again.
 */
export function RecentDictationsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { recordings, error } = useDictationRecordings();

  let body: React.ReactNode;
  if (error) {
    body = <SettingsRow label={t("settings.voice.recordings.loadError")} error={error} />;
  } else if (recordings && recordings.length === 0) {
    body = (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyText}>{t("settings.voice.recordings.empty")}</Text>
      </View>
    );
  } else {
    body = (recordings ?? []).map((recording) => (
      <RecordingRow key={recording.id} serverId={serverId} recording={recording} />
    ));
  }

  return (
    <SettingsSection
      title={t("settings.voice.recordings.title")}
      info={t("settings.voice.recordings.info")}
      testID="voice-recent-dictations"
    >
      <SettingsCard>{body}</SettingsCard>
    </SettingsSection>
  );
}

function RecordingRow({
  serverId,
  recording,
}: {
  serverId: string;
  recording: DictationRecording;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { id, outcome } = recording;

  const retry = useCallback(async () => {
    if (!client) return;
    setRetrying(true);
    setRetryError(null);
    const store = getDictationRecordingStore();
    try {
      const segments = await store.loadSegments(id);
      if (!segments || segments.length === 0) {
        throw new Error(t("settings.voice.recordings.audioMissing"));
      }
      await store.setOutcome(id, await transcribeRecording(client, segments));
    } catch (retryFailure) {
      const message = errorMessage(retryFailure);
      setRetryError(message);
      await store.setOutcome(id, { kind: "failed", error: message }).catch(() => undefined);
    } finally {
      setRetrying(false);
    }
  }, [client, id, t]);

  const copy = useCallback(async () => {
    if (outcome.kind !== "transcribed") return;
    await Clipboard.setStringAsync(outcome.text);
    toast.copied();
  }, [outcome, toast]);

  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.voice.recordings.deleteTitle"),
      message: t("settings.voice.recordings.deleteMessage"),
      confirmLabel: t("settings.voice.recordings.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await getDictationRecordingStore().remove(id);
    } catch (removeError) {
      toast.error(errorMessage(removeError));
    }
  }, [id, t, toast]);

  const createdAt = new Date(recording.createdAt).toLocaleString(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <SettingsRow
      label={outcomeLabel(t, outcome)}
      hint={`${createdAt} · ${formatDuration(recording.durationMs)}`}
      error={retryError ?? undefined}
      testID={`voice-recording-${id}`}
    >
      <View style={styles.actions}>
        {outcome.kind === "transcribed" ? (
          <ToolbarButton label={t("settings.voice.recordings.copy")} onPress={copy}>
            <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </ToolbarButton>
        ) : null}
        <ToolbarButton label={t("settings.voice.recordings.delete")} onPress={remove}>
          <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        </ToolbarButton>
        <Button
          variant="outline"
          leftIcon={RefreshCcw}
          loading={retrying}
          disabled={!client?.isConnected}
          onPress={retry}
          accessibilityLabel={t("settings.voice.recordings.retry")}
        >
          {t("settings.voice.recordings.retry")}
        </Button>
      </View>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
