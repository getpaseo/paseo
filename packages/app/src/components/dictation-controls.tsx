import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic } from "lucide-react-native";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
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
  retryStatusText?: string;
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
  retryStatusText,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const isRetrying = status === "retrying";
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isRetrying || isFailed;
  const actionsDisabled = isProcessing || isRetrying;
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
        <Mic size={16} color={theme.colors.foreground} />
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
          <X size={14} color={theme.colors.foreground} />
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
            <RefreshCcw size={14} color={theme.colors.background} />
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel="Insert transcription"
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={14} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel="Insert transcription and send"
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={14} color={theme.colors.background} />
            </Pressable>
          </>
        )}
      </View>
      {retryStatusText && (isRetrying || isFailed) && (
        <Text
          style={[styles.statusLabel, { color: theme.colors.mutedForeground }]}
        >
          {retryStatusText}
        </Text>
      )}
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
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "retryStatusText">) {
  const { theme } = useUnistyles();
  const isRetrying = status === "retrying";
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isRetrying || isFailed;
  const actionsDisabled = isProcessing || isRetrying;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  if (!showActiveState) {
    return null;
  }

  return (
    <View
      style={[
        overlayStyles.container,
        { backgroundColor: theme.colors.palette.blue[600] },
      ]}
    >
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        style={[
          overlayStyles.cancelButton,
          actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
        ]}
      >
        <X size={20} color={theme.colors.palette.white} strokeWidth={2.5} />
      </Pressable>

      <View style={overlayStyles.centerContainer}>
        <VolumeMeter
          volume={volume}
          isMuted={false}
          isDetecting
          isSpeaking={false}
          orientation="horizontal"
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
            style={[
              overlayStyles.actionButton,
              { backgroundColor: theme.colors.palette.white },
            ]}
          >
            <RefreshCcw
              size={20}
              color={theme.colors.palette.blue[600]}
              strokeWidth={2.5}
            />
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={onAccept}
              style={[
                overlayStyles.actionButton,
                { backgroundColor: "rgba(255, 255, 255, 0.25)" },
              ]}
            >
              <Check
                size={20}
                color={theme.colors.palette.white}
                strokeWidth={2.5}
              />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              style={[
                overlayStyles.actionButton,
                { backgroundColor: theme.colors.palette.white },
              ]}
            >
              <ArrowUp
                size={20}
                color={theme.colors.palette.blue[600]}
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
    backgroundColor: theme.colors.background,
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
    backgroundColor: theme.colors.background,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
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
