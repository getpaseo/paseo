import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { useDownloadStore, formatSpeed, formatEta, type Download } from "@/stores/download-store";

const AUTO_DISMISS_DELAY = 3000;
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foreground,
}));
const ThemedCheck = withUnistyles(Check, (theme) => ({ color: theme.colors.primary }));
const ThemedError = withUnistyles(XCircle, (theme) => ({ color: theme.colors.destructive }));
const ThemedDismiss = withUnistyles(X, (theme) => ({ color: theme.colors.foregroundMuted }));

function getDownloadStatusText(download: Download, t: TFunction): string {
  if (download.status === "downloading") {
    if (download.progress) {
      return `${Math.round(download.progress.percent * 100)}% · ${formatSpeed(download.progress.speed)} · ${formatEta(download.progress.eta)}`;
    }
    return t("common.states.starting");
  }
  if (download.status === "complete") return t("common.states.downloadComplete");
  return download.message ?? t("common.states.downloadFailed");
}

export function DownloadToast() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const downloads = useDownloadStore((state) => state.downloads);
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const dismissDownload = useDownloadStore((state) => state.dismissDownload);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeDownload = activeDownloadId ? downloads.get(activeDownloadId) : null;

  useEffect(() => {
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }

    if (activeDownload?.status === "complete") {
      dismissTimeoutRef.current = setTimeout(() => {
        dismissDownload(activeDownload.id);
      }, AUTO_DISMISS_DELAY);
    }

    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [activeDownload, dismissDownload]);

  const handleDismiss = useCallback(() => {
    if (activeDownload) {
      dismissDownload(activeDownload.id);
    }
  }, [activeDownload, dismissDownload]);

  if (!activeDownload) {
    return null;
  }

  return (
    <View testID="download-toast" style={styles.container(insets.bottom)} pointerEvents="box-none">
      <View style={styles.toast}>
        {activeDownload.status === "downloading" ? <ThemedSpinner size="small" /> : null}
        {activeDownload.status === "complete" ? <ThemedCheck size={18} /> : null}
        {activeDownload.status !== "downloading" && activeDownload.status !== "complete" ? (
          <ThemedError size={18} />
        ) : null}
        <View style={styles.textContainer}>
          <Text style={styles.fileName} numberOfLines={1}>
            {activeDownload.fileName}
          </Text>
          <Text style={styles.status}>{getDownloadStatusText(activeDownload, t)}</Text>
          {activeDownload.status === "downloading" && activeDownload.progress && (
            <View style={styles.progressBar}>
              <ProgressFill percent={activeDownload.progress.percent} />
            </View>
          )}
        </View>
        {activeDownload.status !== "downloading" && (
          <Pressable
            onPress={handleDismiss}
            hitSlop={8}
            style={styles.dismiss}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.dismiss")}
          >
            <ThemedDismiss size={16} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ProgressFill({ percent }: { percent: number }) {
  const width: `${number}%` = `${Math.round(percent * 100)}%`;
  const fillStyle = useMemo(() => [styles.progressFill, { width }], [width]);
  return <View style={fillStyle} />;
}

const styles = StyleSheet.create((theme) => ({
  container: (bottomInset: number) => ({
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 1000,
    bottom: theme.spacing[4] + bottomInset,
  }),
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    ...theme.shadow.md,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progressBar: {
    height: 3,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    marginTop: theme.spacing[1],
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  dismiss: {
    padding: theme.spacing[1],
  },
}));
