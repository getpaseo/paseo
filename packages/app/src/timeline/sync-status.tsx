import type { Theme } from "@/styles/theme";
import { useMemo } from "react";
import type { AgentScreenReadySyncState } from "@/hooks/use-agent-screen-state-machine";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ToastViewport, type ToastState } from "@/components/toast-host";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const spinnerColor = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const keepUntilSynchronized = () => {};

export function TimelineSyncStatus({
  sync,
  toast,
  onDismiss,
}: {
  sync: AgentScreenReadySyncState | null;
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  let state: "reconnecting" | "updating" | null = null;
  if (sync?.status === "reconnecting") state = "reconnecting";
  else if (sync?.status === "catching_up" && sync.ui === "status") state = "updating";
  const label = state ? t(`agentPanel.states.${state}`) : null;
  const syncToast = useMemo<ToastState | null>(
    () =>
      state && label
        ? {
            id: state === "reconnecting" ? 1 : 2,
            content: label,
            nativeMessage: label,
            icon: <ThemedLoadingSpinner size={18} uniProps={spinnerColor} />,
            variant: "default",
            durationMs: null,
            testID: `agent-${state}-toast`,
          }
        : null,
    [state, label],
  );
  return (
    <ToastViewport
      toast={toast ?? syncToast}
      onDismiss={toast ? onDismiss : keepUntilSynchronized}
      placement="panel"
    />
  );
}
