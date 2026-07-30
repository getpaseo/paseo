import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AudioLines, PhoneOff } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { useIsLiveVoiceAvailable } from "@/live-voice/live-voice-availability";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";
import { LiveVoiceStartError } from "@/live-voice/live-voice-runtime";

const BUTTON_ICON_SIZE = 16;

interface LiveVoiceButtonProps {
  serverId: string;
  agentId: string;
}

/**
 * Start/stop control for Live Voice, sized to sit in the composer's trailing
 * control row next to the context-window meter and the dictation button.
 *
 * Renders nothing unless the host and the agent both advertise the capability, so
 * callers can mount it unconditionally.
 */
export function LiveVoiceButton({ serverId, agentId }: LiveVoiceButtonProps) {
  const isAvailable = useIsLiveVoiceAvailable(serverId, agentId);
  const liveVoice = useLiveVoiceOptional();
  const toast = useToast();
  const { t } = useTranslation();

  const isActiveHere = liveVoice?.isActiveForAgent(serverId, agentId) ?? false;
  const isBusy = liveVoice?.phase === "starting" || liveVoice?.phase === "stopping";

  const handlePress = useCallback(() => {
    if (!liveVoice || isBusy) {
      return;
    }
    if (isActiveHere) {
      void liveVoice.stop().catch((error: unknown) => {
        console.error("[LiveVoice] Failed to stop", error);
      });
      return;
    }
    void liveVoice.start(serverId, agentId).catch((error: unknown) => {
      if (error instanceof LiveVoiceStartError) {
        toast.error(resolveLiveVoiceErrorMessage(error.info, t));
        return;
      }
      console.error("[LiveVoice] Failed to start", error);
      toast.error(t("liveVoice.errors.startFailed"));
    });
  }, [agentId, isActiveHere, isBusy, liveVoice, serverId, t, toast]);

  if (!isAvailable || !liveVoice) {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={isBusy}
      accessibilityRole="button"
      accessibilityLabel={isActiveHere ? t("liveVoice.actions.stop") : t("liveVoice.actions.start")}
      style={isActiveHere ? styles.buttonActive : styles.button}
    >
      {isActiveHere ? (
        <ThemedPhoneOff size={BUTTON_ICON_SIZE} uniProps={iconDangerMapping} />
      ) : (
        <ThemedAudioLines size={BUTTON_ICON_SIZE} uniProps={iconMutedMapping} />
      )}
    </Pressable>
  );
}

const ThemedAudioLines = withUnistyles(AudioLines);
const ThemedPhoneOff = withUnistyles(PhoneOff);

const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconDangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  buttonActive: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
}));
