import { useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { useDownloadStore, formatSpeed, formatEta } from "@/stores/download-store";

const AUTO_DISMISS_DELAY = 3000;

export function DownloadToast() {
  const { theme } = useUnistyles();
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

    if (activeDownload && activeDownload.status !== "downloading") {
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

  if (!activeDownload) {
    return null;
  }

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.toast}>
        {activeDownload.status === "downloading" ? (
          <ActivityIndicator size="small" color={theme.colors.foreground} />
        ) : activeDownload.status === "complete" ? (
          <Check size={18} color={theme.colors.primary} />
        ) : (
          <XCircle size={18} color={theme.colors.destructive} />
        )}
        <View style={styles.textContainer}>
          <Text style={styles.fileName} numberOfLines={1}>
            {activeDownload.fileName}
          </Text>
          <Text style={styles.status}>
            {activeDownload.status === "downloading"
              ? activeDownload.progress
                ? `${Math.round(activeDownload.progress.percent * 100)}% · ${formatSpeed(activeDownload.progress.speed)} · ${formatEta(activeDownload.progress.eta)}`
                : "Starting..."
              : activeDownload.status === "complete"
                ? "Download complete"
                : activeDownload.message ?? "Download failed"}
          </Text>
          {activeDownload.status === "downloading" && activeDownload.progress && (
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(activeDownload.progress.percent * 100)}%` },
                ]}
              />
            </View>
          )}
        </View>
        {activeDownload.status !== "downloading" && (
          <Pressable
            onPress={() => dismissDownload(activeDownload.id)}
            hitSlop={8}
            style={styles.dismiss}
          >
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    bottom: theme.spacing[4],
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 1000,
  },
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
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
