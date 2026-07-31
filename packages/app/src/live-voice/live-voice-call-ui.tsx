/**
 * Shared building blocks for the two Live Voice call surfaces: the docked
 * bottom strip and the sidebar card. Both are thin views over the same
 * app-global runtime; exactly one is active at a time (see
 * `live-voice-placement.ts`).
 */

import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import type { LiveVoicePhase, LiveVoiceTranscriptEntry } from "@/live-voice/live-voice-runtime";
import type { LiveVoiceSessionMode } from "@/live-voice/live-voice-session";

const ICON_SIZE = 14;
/** How close to the end counts as "pinned to the bottom" for auto-scroll. */
const PINNED_THRESHOLD = 48;

/** The large call surface exists only while a call is being established, live, or stopped. */
export function isLiveVoiceCallInProgress(phase: LiveVoicePhase): boolean {
  return phase === "starting" || phase === "active" || phase === "stopping";
}

export function resolveLiveVoiceStatusLabel(args: {
  phase: LiveVoicePhase;
  isAudioBlocked: boolean;
  t: (key: string) => string;
}): string {
  const { phase, isAudioBlocked, t } = args;
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
  return t("liveVoice.status.ended");
}

export function resolveLiveVoiceModeLabel(args: {
  sessionMode: LiveVoiceSessionMode | null;
  t: (key: string) => string;
}): string | null {
  const { sessionMode, t } = args;
  if (sessionMode === "foreground") {
    return t("liveVoice.modes.foreground");
  }
  if (sessionMode === "background") {
    return t("liveVoice.modes.background");
  }
  return null;
}

/**
 * The in-call control cluster: enable-audio (when autoplay is blocked), mute
 * (while live), the transcript toggle, and stop. Terminal status and dismissal
 * live in the footer menu after the large call surface disappears. Rendered as
 * a fragment so each surface owns the row it sits in.
 */
export function LiveVoiceCallControls({
  isExpanded,
  onToggleExpanded,
}: {
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const liveVoice = useLiveVoiceOptional();
  const { t } = useTranslation();

  const handleToggleMute = useCallback(() => {
    liveVoice?.toggleMute();
  }, [liveVoice]);

  const handleStop = useCallback(() => {
    void liveVoice?.stop().catch((error: unknown) => {
      console.error("[LiveVoice] Failed to stop", error);
    });
  }, [liveVoice]);

  const handleResumeAudio = useCallback(() => {
    void liveVoice?.resumeAudio().catch((error: unknown) => {
      console.error("[LiveVoice] Failed to resume audio", error);
    });
  }, [liveVoice]);

  if (!liveVoice) {
    return null;
  }
  const { phase, isMuted, isAudioBlocked } = liveVoice;

  return (
    <>
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
          accessibilityLabel={isMuted ? t("liveVoice.actions.unmute") : t("liveVoice.actions.mute")}
          style={styles.iconButton}
        >
          {isMuted ? (
            <ThemedMicOff size={ICON_SIZE} uniProps={iconDangerMapping} />
          ) : (
            <ThemedMic size={ICON_SIZE} uniProps={iconForegroundMapping} />
          )}
        </Pressable>
      ) : null}

      <Pressable
        onPress={onToggleExpanded}
        accessibilityRole="button"
        accessibilityLabel={
          isExpanded ? t("liveVoice.actions.hideTranscript") : t("liveVoice.actions.showTranscript")
        }
        style={styles.iconButton}
      >
        {isExpanded ? (
          <ThemedChevronDown size={ICON_SIZE} uniProps={iconForegroundMapping} />
        ) : (
          <ThemedChevronUp size={ICON_SIZE} uniProps={iconForegroundMapping} />
        )}
      </Pressable>

      <Pressable
        onPress={handleStop}
        disabled={phase === "stopping"}
        accessibilityRole="button"
        accessibilityLabel={t("liveVoice.actions.stop")}
        style={styles.iconButton}
      >
        <ThemedPhoneOff size={ICON_SIZE} uniProps={iconDangerMapping} />
      </Pressable>
    </>
  );
}

/**
 * The expanded transcript: bounded height, sticks to the newest line unless the
 * user has scrolled up to read history. The surface supplies the max height so
 * the sidebar card and the full-width strip can bound it differently.
 */
export function LiveVoiceTranscript({
  transcripts,
  errorText,
  maxHeight,
}: {
  transcripts: LiveVoiceTranscriptEntry[];
  errorText: string | null;
  maxHeight: number;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const isPinnedRef = useRef(true);
  const scrollStyle = useMemo(() => ({ maxHeight }), [maxHeight]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    isPinnedRef.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height < PINNED_THRESHOLD;
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (isPinnedRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  return (
    <View style={styles.transcript}>
      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      {transcripts.length === 0 ? (
        <Text style={styles.transcriptEmpty}>{t("liveVoice.transcript.empty")}</Text>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={scrollStyle}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          scrollEventThrottle={16}
        >
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
        </ScrollView>
      )}
    </View>
  );
}

export function LiveVoiceStatusDot({ phase }: { phase: LiveVoicePhase }) {
  return <View style={phase === "active" ? styles.liveDot : styles.idleDot} />;
}

const ThemedMic = withUnistyles(Mic);
const ThemedMicOff = withUnistyles(MicOff);
const ThemedPhoneOff = withUnistyles(PhoneOff);
const ThemedVolume2 = withUnistyles(Volume2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconDangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const styles = StyleSheet.create((theme) => ({
  // `statusSuccess` rather than `primary`: primary is near-black in the light
  // themes, and a call indicator should read "live" in every scheme.
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
  },
  idleDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
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
  transcript: {
    gap: theme.spacing[1],
  },
  transcriptList: {
    gap: theme.spacing[1],
  },
  transcriptEmpty: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  transcriptEntry: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  transcriptRole: {
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
