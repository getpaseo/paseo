import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { VideoPlayer } from "./player";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const loadingSpinnerProps = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function FileVideoPreview({ uri }: { uri: string | null }) {
  const { t } = useTranslation();
  const isPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const active = isPanelActive && isAppVisible;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const onLoad = useCallback(() => setStatus("ready"), []);
  const onError = useCallback(() => setStatus("error"), []);
  const onRetry = useCallback(() => setStatus("loading"), []);

  if (status === "error") {
    return (
      <View style={styles.state} testID="video-file-preview-error">
        <Text style={styles.message}>{t("panels.file.videoPlaybackFailed")}</Text>
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="video-file-preview">
      {uri ? <VideoPlayer uri={uri} active={active} onLoad={onLoad} onError={onError} /> : null}
      {status === "loading" ? (
        <View style={styles.loading} pointerEvents="none" testID="video-file-preview-loading">
          <ThemedLoadingSpinner size="small" uniProps={loadingSpinnerProps} />
          <Text style={styles.message}>{t("panels.file.loading")}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center" },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
