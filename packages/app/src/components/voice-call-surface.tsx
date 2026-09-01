import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RealtimeVoiceOverlay } from "@/components/realtime-voice-overlay";
import { useVoiceOptional } from "@/contexts/voice-context";
import type { VoiceCallEvent } from "@getpaseo/protocol/messages";

function VoiceCallEventRow({ event }: { event: VoiceCallEvent }) {
  switch (event.type) {
    case "transcript":
      return (
        <Text style={styles.eventText}>
          <Text style={styles.eventLabel}>{event.speaker === "user" ? "You:" : "Paseo:"} </Text>
          {event.text}
        </Text>
      );
    case "activity":
      return (
        <View style={styles.activityRow}>
          <Text style={styles.activityLabel}>{event.label}</Text>
          <Text style={styles.activityState}>{event.state}</Text>
        </View>
      );
    case "notice":
      return <Text style={styles.notice}>{event.text}</Text>;
    case "error":
      return <Text style={styles.error}>{event.message}</Text>;
  }
}

export function VoiceCallSurface() {
  const voice = useVoiceOptional();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const toggleTranscript = useCallback(() => setTranscriptOpen((open) => !open), []);

  if (!voice || (!voice.isVoiceMode && voice.events.length === 0)) return null;

  const showTranscript = transcriptOpen || !voice.isVoiceMode;

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View style={styles.surface}>
        {showTranscript ? (
          <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
            {voice.events.length === 0 ? (
              <Text style={styles.empty}>Conversation will appear here.</Text>
            ) : (
              voice.events.map((event) => <VoiceCallEventRow key={event.id} event={event} />)
            )}
          </ScrollView>
        ) : null}
        {voice.isVoiceMode ? (
          <RealtimeVoiceOverlay
            isMuted={voice.isMuted}
            isSwitching={voice.isVoiceSwitching}
            isTranscriptOpen={transcriptOpen}
            onToggleTranscript={toggleTranscript}
            onToggleMute={voice.toggleMute}
            onStop={voice.stopVoice}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss voice transcript"
            onPress={voice.dismissTranscript}
            style={styles.transcriptButton}
          >
            <Text style={styles.transcriptButtonText}>Dismiss</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  host: {
    width: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1.5],
  },
  surface: {
    width: "100%",
    gap: theme.spacing[2],
  },
  transcript: {
    maxHeight: 200,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  transcriptContent: {
    gap: theme.spacing[1.5],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  eventText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  eventLabel: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  activityRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  activityLabel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  activityState: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  transcriptButton: {
    alignSelf: "flex-end",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  transcriptButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
}));
