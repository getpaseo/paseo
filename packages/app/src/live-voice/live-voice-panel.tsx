import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Mic, MicOff, Volume2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { useIsLiveVoiceAvailable } from "@/live-voice/live-voice-availability";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";

const ICON_SIZE = 14;

interface LiveVoicePanelProps {
  serverId: string;
  agentId: string;
}

/**
 * Phase-1 status surface for an in-progress Live Voice call: connection state, the
 * mute toggle, the autoplay-unblock affordance, and the finalized transcript.
 *
 * Deliberately a plain block above the composer input rather than an anchored
 * popover — it is a dev-facing surface and floating panels carry their own
 * lifecycle problems (see docs/floating-panels.md).
 */
export function LiveVoicePanel({ serverId, agentId }: LiveVoicePanelProps) {
  const isAvailable = useIsLiveVoiceAvailable(serverId, agentId);
  const liveVoice = useLiveVoiceOptional();
  const { t } = useTranslation();

  const handleResumeAudio = useCallback(() => {
    void liveVoice?.resumeAudio().catch((error: unknown) => {
      console.error("[LiveVoice] Failed to resume audio", error);
    });
  }, [liveVoice]);

  const handleToggleMute = useCallback(() => {
    liveVoice?.toggleMute();
  }, [liveVoice]);

  if (!isAvailable || !liveVoice) {
    return null;
  }
  // The runtime is app-global (one call at a time); only render on the agent that
  // owns the call, and only while there is something to say about it.
  if (liveVoice.serverId !== serverId || liveVoice.agentId !== agentId) {
    return null;
  }
  const { phase, error, transcripts, isMuted, isAudioBlocked, closedCause } = liveVoice;
  if (phase === "idle" && !closedCause) {
    return null;
  }

  const statusLabel = resolveStatusLabel({
    phase,
    isAudioBlocked,
    hasClosed: Boolean(closedCause),
    t,
  });
  const errorText = error ? resolveLiveVoiceErrorMessage(error, t) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("liveVoice.label")}</Text>
        <Text style={phase === "error" ? styles.statusError : styles.status}>{statusLabel}</Text>
        <View style={styles.headerActions}>
          {isAudioBlocked ? (
            <Pressable
              onPress={handleResumeAudio}
              accessibilityRole="button"
              accessibilityLabel={t("liveVoice.actions.enableAudio")}
              style={styles.enableAudioButton}
            >
              <ThemedVolume2 size={ICON_SIZE} uniProps={iconForegroundMapping} />
              <Text style={styles.enableAudioLabel}>{t("liveVoice.actions.enableAudio")}</Text>
            </Pressable>
          ) : null}
          {phase === "active" ? (
            <Pressable
              onPress={handleToggleMute}
              accessibilityRole="button"
              accessibilityLabel={
                isMuted ? t("liveVoice.actions.unmute") : t("liveVoice.actions.mute")
              }
              style={styles.iconButton}
            >
              {isMuted ? (
                <ThemedMicOff size={ICON_SIZE} uniProps={iconDangerMapping} />
              ) : (
                <ThemedMic size={ICON_SIZE} uniProps={iconForegroundMapping} />
              )}
            </Pressable>
          ) : null}
        </View>
      </View>

      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}

      {transcripts.length === 0 ? (
        <Text style={styles.transcriptEmpty}>{t("liveVoice.transcript.empty")}</Text>
      ) : (
        <View style={styles.transcriptList}>
          {transcripts.map((entry) => (
            <Text key={entry.id} style={styles.transcriptEntry}>
              <Text style={styles.transcriptRole}>
                {entry.role === "user"
                  ? t("liveVoice.transcript.user")
                  : t("liveVoice.transcript.assistant")}
              </Text>
              {` ${entry.text}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function resolveStatusLabel(args: {
  phase: string;
  isAudioBlocked: boolean;
  hasClosed: boolean;
  t: (key: string) => string;
}): string {
  const { phase, isAudioBlocked, hasClosed, t } = args;
  if (phase === "error") {
    return t("liveVoice.status.error");
  }
  if (phase === "starting") {
    return t("liveVoice.status.connecting");
  }
  if (phase === "stopping") {
    return t("liveVoice.status.stopping");
  }
  if (phase === "active") {
    return isAudioBlocked ? t("liveVoice.status.audioBlocked") : t("liveVoice.status.live");
  }
  return hasClosed ? t("liveVoice.status.ended") : t("liveVoice.status.connecting");
}

const ThemedMic = withUnistyles(Mic);
const ThemedMicOff = withUnistyles(MicOff);
const ThemedVolume2 = withUnistyles(Volume2);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconDangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const styles = StyleSheet.create((theme) => ({
  container: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  status: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusError: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  headerActions: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
  },
  enableAudioButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  enableAudioLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  transcriptEmpty: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  transcriptList: {
    gap: theme.spacing[1],
  },
  transcriptEntry: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  transcriptRole: {
    color: theme.colors.foregroundMuted,
  },
}));
