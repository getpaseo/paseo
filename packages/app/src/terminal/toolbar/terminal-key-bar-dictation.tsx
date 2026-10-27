import { useMemo, type ReactNode } from "react";
import { Mic } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { DictationOverlay } from "@/components/dictation-controls";
import { TerminalKeyBarIconAction } from "@/components/terminal-copy-paste-actions";
import type { Theme } from "@/styles/theme";
import { useTerminalDictationState, type TerminalInputSink } from "@/terminal/input-sink";

const ThemedMic = withUnistyles(Mic);
const keyBarIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TerminalKeyBarDictationProps {
  /** The pane's own sink: a key bar acts on its pane, never on a newer pane of the same terminal. */
  sink: TerminalInputSink;
}

/** The key-bar mic. Disabled while the pane has no dictation owner (host disconnected). */
export function TerminalKeyBarDictationButton({ sink }: TerminalKeyBarDictationProps) {
  const { t } = useTranslation();
  const state = useTerminalDictationState(sink.dictation.ownerId);
  const icon = useMemo(() => <ThemedMic size={16} uniProps={keyBarIconColorMapping} />, []);
  return (
    <TerminalKeyBarIconAction
      accessibilityLabel={t("workspace.terminal.actions.startDictation")}
      testID="terminal-dictation"
      icon={icon}
      disabled={!state}
      onPress={sink.dictation.toggle}
    />
  );
}

/**
 * Shows the key bar's rows while the pane's terminal is not dictating, and the
 * dictation overlay in their place through recording, paused, processing and
 * failed. The rows come back once the attempt is delivered, cancelled or discarded.
 * Lives apart from the pane so volume ticks re-render only this component.
 */
export function TerminalKeyBarDictationGate({
  sink,
  children,
}: TerminalKeyBarDictationProps & { children: ReactNode }) {
  const state = useTerminalDictationState(sink.dictation.ownerId);
  if (!state || state.status === "idle") {
    return children;
  }
  // Also recording while the microphone is still being acquired, so cancel is reachable then.
  const isRecording =
    state.isRecording || state.status === "recording" || state.status === "paused";
  return (
    <DictationOverlay
      testID="terminal-dictation-overlay"
      volume={state.volume}
      duration={state.duration}
      isRecording={isRecording}
      isProcessing={state.isProcessing}
      status={state.status}
      errorText={state.status === "failed" ? (state.error ?? undefined) : undefined}
      onCancel={sink.dictation.cancel}
      onAccept={sink.dictation.confirm}
      onRetry={sink.dictation.retry}
      onDiscard={sink.dictation.discard}
    />
  );
}
