import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { renderAsync } from "docx-preview";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceFilePreviewProps } from "@/components/workspace-file-previews/types";

export function WorkspaceDocxPreview({ bytes }: WorkspaceFilePreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hostStyle = useMemo(
    () => [styles.webHost, (loading || error) && styles.hiddenHost],
    [error, loading],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.innerHTML = "";
    setLoading(true);
    setError(null);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    void renderAsync(blob, container, undefined, {
      className: "paseo-docx-preview",
      inWrapper: true,
      ignoreFonts: true,
    })
      .catch((renderError: unknown) => {
        setError(renderError instanceof Error ? renderError.message : "Failed to render document");
      })
      .finally(() => setLoading(false));
  }, [bytes]);

  const host = createElement("div", {
    ref: containerRef,
    style: {
      boxSizing: "border-box",
      minHeight: "100%",
      padding: 16,
      overflow: "auto",
    },
  });

  return (
    <View style={styles.container}>
      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" />
          <Text style={styles.loadingText}>Loading document...</Text>
        </View>
      ) : null}
      {error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      <View style={hostStyle}>{host}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  webHost: {
    flex: 1,
    minHeight: 0,
  },
  hiddenHost: {
    opacity: 0,
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  loadingText: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
