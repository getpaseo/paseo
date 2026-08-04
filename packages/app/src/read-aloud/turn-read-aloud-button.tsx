import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { CircleStop, Volume2, VolumeX } from "lucide-react-native";

import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isReadAloudAudioSupported } from "@/read-aloud/read-aloud-audio";
import {
  startReadAloud,
  stopReadAloud,
  useReadAloudSnapshot,
  type ReadAloudSnapshot,
} from "@/read-aloud/read-aloud-store";
import { useReadAloudServerId } from "@/read-aloud/use-read-aloud-host";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const turnReadAloudButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "center",
    padding: theme.spacing[1],
    marginTop: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
  iconFailedColor: {
    color: theme.colors.destructive,
  },
}));

interface TurnReadAloudButtonProps {
  /** Assistant message id — identifies this turn as the playback owner. */
  turnId: string;
  /** The turn's closing prose. An empty string hides the button. */
  getSpeech: () => string;
  containerStyle?: StyleProp<ViewStyle>;
}

function renderIcon(params: {
  status: ReadAloudSnapshot["status"];
  failed: boolean;
  color: string;
}): ReactNode {
  if (params.status === "loading") {
    return <LoadingSpinner size="small" color={params.color} />;
  }
  if (params.status === "speaking") {
    // Outlined circle around the stop square: a filled square alone reads as a
    // solid blob at footer size, next to the outlined copy and fork icons.
    return <CircleStop size={16} color={params.color} />;
  }
  if (params.failed) {
    return <VolumeX size={16} color={params.color} />;
  }
  return <Volume2 size={16} color={params.color} />;
}

// `hovered` is optional: Pressable's render prop types it as `boolean | undefined`
// on platforms with no pointer.
function resolveIconColor(params: {
  failed: boolean;
  hovered: boolean | undefined;
  status: ReadAloudSnapshot["status"];
}): string {
  if (params.failed) {
    return turnReadAloudButtonStylesheet.iconFailedColor.color;
  }
  // Playback keeps the button at full strength so the stop affordance reads as
  // active without the pointer sitting on it.
  if (params.hovered || params.status !== "idle") {
    return turnReadAloudButtonStylesheet.iconHoveredColor.color;
  }
  return turnReadAloudButtonStylesheet.iconColor.color;
}

/**
 * Speak the end of an assistant turn.
 *
 * Playback is a single app-wide slot, so this compares the store's `ownerId`
 * against its own turn: pressing a second turn's button supersedes the first
 * rather than stacking two voices.
 *
 * Hidden when the turn has nothing to say after its last tool call, when the
 * route host doesn't advertise the capability, and on platforms with no audio
 * engine — a button that cannot make sound is worse than no button.
 */
export const TurnReadAloudButton = memo(function TurnReadAloudButton({
  turnId,
  getSpeech,
  containerStyle,
}: TurnReadAloudButtonProps) {
  const { t } = useTranslation();
  const snapshot = useReadAloudSnapshot();
  const serverId = useReadAloudServerId();
  const client = useHostRuntimeClient(serverId ?? "");

  const isOwner = snapshot.ownerId === turnId;
  const status = isOwner ? snapshot.status : "idle";
  const failed = isOwner && snapshot.failure !== null;

  const handlePress = useCallback(() => {
    if (status !== "idle") {
      stopReadAloud();
      return;
    }
    const text = getSpeech();
    if (!text || !client || !serverId) {
      return;
    }
    startReadAloud({ client, text, ownerId: turnId, serverId });
  }, [client, getSpeech, serverId, status, turnId]);

  const pressableStyle = useMemo(
    () => [turnReadAloudButtonStylesheet.container, containerStyle],
    [containerStyle],
  );

  // Called during render rather than in the press handler so a turn ending on a
  // tool call never shows a button that would do nothing.
  const hasSpeech = getSpeech().length > 0;
  if (!hasSpeech || !serverId || !isReadAloudAudioSupported) {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      style={pressableStyle}
      accessibilityRole="button"
      accessibilityLabel={status === "idle" ? t("readAloud.action") : t("readAloud.stop")}
      testID="turn-read-aloud-button"
    >
      {({ hovered }) =>
        renderIcon({ status, failed, color: resolveIconColor({ failed, hovered, status }) })
      }
    </Pressable>
  );
});
