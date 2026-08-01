import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
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
import { acquireSidebarVoiceSlot } from "@/live-voice/live-voice-placement";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";
import { useHosts } from "@/runtime/host-runtime";

const TRANSCRIPT_MAX_HEIGHT = 240;

/**
 * Mounted by a sidebar wherever the voice card should live. While `active`
 * (the sidebar is really on screen) it claims the call surface — which hides
 * the docked strip — whether or not a call exists, so ownership never flaps
 * mid-call. Outside an in-progress call it renders nothing; the footer button
 * starts calls and exposes terminal status.
 */
export function SidebarLiveVoiceSlot({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) {
      return;
    }
    return acquireSidebarVoiceSlot();
  }, [active]);

  if (!active) {
    return null;
  }
  return <LiveVoiceSidebarCard />;
}

/**
 * Discord-style voice card above the sidebar footer: the sidebar-housed
 * counterpart of the docked strip, column-shaped so the transcript expands
 * naturally inside the sidebar.
 */
function LiveVoiceSidebarCard() {
  const liveVoice = useLiveVoiceOptional();
  const hosts = useHosts();
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggleExpanded = useCallback(() => {
    setIsExpanded((current) => !current);
  }, []);

  if (!liveVoice) {
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
    <View testID="live-voice-sidebar-card" style={styles.card}>
      <View style={styles.headerRow}>
        <LiveVoiceStatusDot phase={phase} />
        <Text style={styles.title}>{t("liveVoice.label")}</Text>
        <Text style={phase === "error" ? styles.statusError : styles.status}>{statusLabel}</Text>
      </View>
      {hostLabel || modeLabel ? (
        <View style={styles.metadataRow}>
          {hostLabel ? (
            <Text numberOfLines={1} style={styles.hostLabel}>
              {hostLabel}
            </Text>
          ) : null}
          {modeLabel ? <Text style={styles.modeLabel}>{modeLabel}</Text> : null}
        </View>
      ) : null}

      {isExpanded ? (
        <LiveVoiceTranscript
          transcripts={transcripts}
          errorText={errorText}
          maxHeight={TRANSCRIPT_MAX_HEIGHT}
        />
      ) : null}
      {!isExpanded && latestTranscript ? (
        <Text numberOfLines={2} style={styles.preview}>
          {latestTranscript.text}
        </Text>
      ) : null}
      {!isExpanded && errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}

      <View style={styles.controlsRow}>
        <LiveVoiceCallControls isExpanded={isExpanded} onToggleExpanded={handleToggleExpanded} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A step above the sidebar's own background in every theme; tokens only, so
  // all six color schemes get a coherent "slightly different" card.
  card: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
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
  hostLabel: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  metadataRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modeLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  preview: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
