import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { useIsLiveVoiceAvailable } from "@/live-voice/live-voice-availability";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";
import { LiveVoiceStartError } from "@/live-voice/live-voice-runtime";

const BUTTON_ICON_SIZE = 16;

interface LiveVoiceButtonProps {
  serverId: string;
}

/**
 * Start control for Live Voice, sized to sit in the composer's trailing control
 * row next to the context-window meter and the dictation button.
 *
 * Start-only on purpose: a call is daemon-global and outlives any one screen, so
 * every in-call control (mute, stop, transcript) lives on the app-level call
 * strip. While a call is non-idle this button yields to the strip entirely.
 *
 * Renders nothing unless the host advertises the capability, so callers can
 * mount it unconditionally.
 */
export function LiveVoiceButton({ serverId }: LiveVoiceButtonProps) {
  const isAvailable = useIsLiveVoiceAvailable(serverId);
  const liveVoice = useLiveVoiceOptional();
  const toast = useToast();
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    if (!liveVoice) {
      return;
    }
    void liveVoice.start(serverId).catch((error: unknown) => {
      if (error instanceof LiveVoiceStartError) {
        toast.error(resolveLiveVoiceErrorMessage(error.info, t));
        return;
      }
      console.error("[LiveVoice] Failed to start", error);
      toast.error(t("liveVoice.errors.startFailed"));
    });
  }, [liveVoice, serverId, t, toast]);

  if (!isAvailable || !liveVoice || liveVoice.phase !== "idle") {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("liveVoice.actions.start")}
      style={styles.button}
    >
      <ThemedAudioLines size={BUTTON_ICON_SIZE} uniProps={iconMutedMapping} />
    </Pressable>
  );
}

const ThemedAudioLines = withUnistyles(AudioLines);

const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
}));
