import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import {
  isLiveVoiceCallInProgress,
  LiveVoiceCallControls,
  LiveVoiceStatusDot,
  LiveVoiceTranscript,
  resolveLiveVoiceModeLabel,
  resolveLiveVoiceStatusLabel,
} from "@/live-voice/live-voice-call-ui";
import { useSidebarOwnsLiveVoiceSurface } from "@/live-voice/live-voice-placement";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";
import { useHosts } from "@/runtime/host-runtime";

const TRANSCRIPT_MAX_HEIGHT = 280;

/**
 * Fallback surface for the (single, daemon-global) Live Voice call: a slim bar
 * docked into the root layout's flow — not floating — so it never occludes the
 * composer or any screen content, and it survives navigation because the call
 * belongs to no screen. Collapsed it is a status bar with the in-call controls;
 * expanded it grows upward into a bounded, bottom-pinned transcript.
 *
 * When a visible sidebar offers a voice slot, the sidebar card owns the call
 * surface instead and this renders nothing. Idle it renders nothing at all —
 * starting a call and inspecting terminal status are the footer button's jobs.
 */
export function LiveVoiceStrip() {
  const sidebarOwnsSurface = useSidebarOwnsLiveVoiceSurface();
  const liveVoice = useLiveVoiceOptional();
  const hosts = useHosts();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggleExpanded = useCallback(() => {
    setIsExpanded((current) => !current);
  }, []);

  if (sidebarOwnsSurface || !liveVoice) {
    return null;
  }
  const { phase, serverId, sessionMode, transcripts, isAudioBlocked, error } = liveVoice;
  if (!isLiveVoiceCallInProgress(phase)) {
    return null;
  }

  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? null;
  const modeLabel = resolveLiveVoiceModeLabel({ sessionMode, t });
  const statusLabel = resolveLiveVoiceStatusLabel({ phase, isAudioBlocked, t });
  const errorText = error ? resolveLiveVoiceErrorMessage(error, t) : null;
  const latestTranscript = transcripts.length > 0 ? transcripts[transcripts.length - 1] : null;

  return (
    <View testID="live-voice-strip" style={[styles.container, { paddingBottom: insets.bottom }]}>
      {isExpanded ? (
        <View style={styles.transcriptSection}>
          <LiveVoiceTranscript
            transcripts={transcripts}
            errorText={errorText}
            maxHeight={TRANSCRIPT_MAX_HEIGHT}
          />
        </View>
      ) : null}

      <View style={styles.bar}>
        <LiveVoiceStatusDot phase={phase} />
        <Text style={styles.title}>{t("liveVoice.label")}</Text>
        {hostLabel ? <Text style={styles.hostLabel}>{hostLabel}</Text> : null}
        {modeLabel ? <Text style={styles.modeLabel}>{modeLabel}</Text> : null}
        <Text style={phase === "error" ? styles.statusError : styles.status}>{statusLabel}</Text>

        {!isExpanded && latestTranscript ? (
          <Text numberOfLines={1} style={styles.preview}>
            {latestTranscript.text}
          </Text>
        ) : (
          <View style={styles.previewSpacer} />
        )}

        <LiveVoiceCallControls isExpanded={isExpanded} onToggleExpanded={handleToggleExpanded} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  hostLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  modeLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
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
  preview: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  previewSpacer: {
    flex: 1,
  },
  transcriptSection: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));
