import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Start voice dictation"
        style={[styles.micButton, disabled && styles.buttonDisabled]}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter
          volume={volume}
          isMuted={false}
          isDetecting
          isSpeaking={false}
          orientation="horizontal"
        />
      </View>
      <Text style={[styles.timerText, { color: theme.colors.foreground }]}>
        {formatDuration(duration)}
      </Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel="Cancel dictation"
          style={[
            styles.actionButton,
            styles.actionButtonCancel,
            actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
          ]}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={theme.colors.foreground} />
          </View>
        ) : isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel="Retry dictation"
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel="Insert transcription"
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel="Insert transcription and send"
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

/**
 * Full-width overlay variant for the agent input footer.
 * Uses blue background with white icons.
 */
export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "transcript"> & { errorText?: string }) {
  const { theme } = useUnistyles();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  if (!showActiveState) {
    return null;
  }

  return (
    <View
      style={[
        overlayStyles.container,
        { backgroundColor: theme.colors.accent },
      ]}
    >
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        accessibilityRole="button"
        accessibilityLabel="Cancel dictation"
        style={[
          overlayStyles.cancelButton,
          actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
        ]}
      >
        <X size={theme.iconSize.lg} color={theme.colors.palette.white} strokeWidth={2.5} />
      </Pressable>

      <View style={overlayStyles.centerContainer}>
        <View style={overlayStyles.meterRow}>
          <VolumeMeter
            volume={volume}
            isMuted={false}
            isDetecting
            isSpeaking={false}
            orientation="horizontal"
            color={theme.colors.palette.white}
          />
          <Text
            style={[
              overlayStyles.timerText,
              { color: theme.colors.palette.white },
            ]}
          >
            {formatDuration(duration)}
          </Text>
        </View>
        {isFailed ? (
          <Text
            numberOfLines={2}
            style={[
              overlayStyles.transcriptText,
              { color: theme.colors.palette.white, opacity: 0.95 },
            ]}
          >
            {errorText ? `Dictation failed: ${errorText}` : "Dictation failed. Tap retry."}
          </Text>
        ) : null}
      </View>

      <View style={overlayStyles.actionButtonsContainer}>
        {actionsDisabled ? (
          <View style={overlayStyles.loadingContainer}>
            <ActivityIndicator
              size="small"
              color={theme.colors.palette.white}
            />
          </View>
        ) : isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry dictation"
            style={[
              overlayStyles.actionButton,
              { backgroundColor: theme.colors.palette.white },
            ]}
          >
            <RefreshCcw
              size={theme.iconSize.lg}
              color={theme.colors.accent}
              strokeWidth={2.5}
            />
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel="Insert transcription"
              style={[
                overlayStyles.actionButton,
                { backgroundColor: "rgba(255, 255, 255, 0.25)" },
              ]}
            >
              <Pencil
                size={theme.iconSize.lg}
                color={theme.colors.palette.white}
                strokeWidth={2.5}
              />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityRole="button"
              accessibilityLabel="Insert transcription and send"
              style={[
                overlayStyles.actionButton,
                { backgroundColor: theme.colors.palette.white },
              ]}
            >
              <ArrowUp
                size={theme.iconSize.lg}
                color={theme.colors.accent}
                strokeWidth={2.5}
              />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

const overlayStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  transcriptText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.9,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
}));
