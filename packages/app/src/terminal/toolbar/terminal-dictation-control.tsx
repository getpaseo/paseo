import { Check, Mic, RefreshCcw, X } from "lucide-react-native";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { VolumeMeter } from "@/components/volume-meter";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { Theme } from "@/styles/theme";
import { formatDictationDuration } from "@/utils/format-dictation-duration";
import type { TerminalDictationState, TerminalInputSink } from "@/terminal/input-sink";

const ThemedMic = withUnistyles(Mic);
const ThemedX = withUnistyles(X);
const ThemedCheck = withUnistyles(Check);
const ThemedRefresh = withUnistyles(RefreshCcw);
const ThemedVolumeMeter = withUnistyles(VolumeMeter);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const activeIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const accentIconColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

interface TerminalDictationControlProps {
  sink: TerminalInputSink;
  /** Null while the pane has no dictation owner mounted (host disconnected). */
  state: TerminalDictationState | null;
}

/**
 * The terminal's mic in its pane's tab bar. Idle it is one button; while the
 * terminal records, processes or has failed, the same slot becomes a pill with
 * cancel, meter and duration, and confirm (or retry and discard after a failure).
 * A view of the pane's dictation owner: every press goes through the sink.
 */
export function TerminalDictationControl({ sink, state }: TerminalDictationControlProps) {
  const { t } = useTranslation();
  const shortcut = useShortcutKeys("terminal-dictation-toggle");
  const status = state?.status ?? "idle";

  if (!state || status === "idle") {
    return (
      <ToolbarButton
        label={t("workspace.terminal.actions.startDictation")}
        shortcut={shortcut}
        testID="terminal-toolbar-dictation"
        disabled={!state}
        onPress={sink.dictation.toggle}
      >
        <ThemedMic size={14} uniProps={iconColorMapping} />
      </ToolbarButton>
    );
  }

  const isFailed = status === "failed";
  const isProcessing = state.isProcessing;

  return (
    <View style={styles.pill} testID="terminal-dictation-pill">
      {isFailed ? (
        <ToolbarButton
          label={t("workspace.terminal.dictation.discard")}
          testID="terminal-dictation-discard"
          round
          onPress={sink.dictation.discard}
        >
          <ThemedX size={14} uniProps={activeIconColorMapping} />
        </ToolbarButton>
      ) : (
        <ToolbarButton
          label={t("message.dictation.cancel")}
          testID="terminal-dictation-cancel"
          round
          onPress={sink.dictation.cancel}
        >
          <ThemedX size={14} uniProps={activeIconColorMapping} />
        </ToolbarButton>
      )}
      {isFailed ? (
        <Text style={styles.errorText} numberOfLines={1} testID="terminal-dictation-error">
          {state.error
            ? t("message.dictation.failed", { error: state.error })
            : t("message.dictation.failedRetry")}
        </Text>
      ) : (
        <View style={styles.meter}>
          <ThemedVolumeMeter
            volume={state.volume}
            orientation="horizontal"
            variant="compact"
            uniProps={accentIconColorMapping}
          />
          <Text style={styles.duration}>
            {status === "paused"
              ? t("message.dictation.paused")
              : formatDictationDuration(state.duration)}
          </Text>
        </View>
      )}
      {isProcessing ? (
        <View style={styles.spinner}>
          <ThemedSpinner size="small" uniProps={activeIconColorMapping} />
        </View>
      ) : null}
      {!isProcessing && isFailed ? (
        <ToolbarButton
          label={t("message.dictation.retry")}
          testID="terminal-dictation-retry"
          round
          onPress={sink.dictation.retry}
        >
          <ThemedRefresh size={14} uniProps={accentIconColorMapping} />
        </ToolbarButton>
      ) : null}
      {!isProcessing && !isFailed ? (
        <ToolbarButton
          label={t("workspace.terminal.actions.stopDictation")}
          shortcut={shortcut}
          testID="terminal-dictation-confirm"
          round
          onPress={sink.dictation.confirm}
        >
          <ThemedCheck size={14} uniProps={accentIconColorMapping} />
        </ToolbarButton>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface1,
  },
  meter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  duration: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  errorText: {
    maxWidth: 160,
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
}));
