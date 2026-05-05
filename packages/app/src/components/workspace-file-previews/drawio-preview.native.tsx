import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Save } from "lucide-react-native";
import NativeWebView, { type WebViewMessageEvent } from "react-native-webview";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { bytesToUtf8 } from "@/components/workspace-file-previews/bytes";
import type { WorkspaceDrawioPreviewProps } from "@/components/workspace-file-previews/types";

const WEBVIEW_ORIGIN_WHITELIST = ["*"];

function escapeScriptString(value: string): string {
  return JSON.stringify(value);
}

function buildDrawioHtml(title: string): string {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>html,body,#frame{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
</head>
<body>
<iframe id="frame" title="${title.replace(/"/g, "&quot;")}" src="https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min&libraries=1&saveAndExit=0&noExitBtn=1"></iframe>
<script>
const frame = document.getElementById('frame');
window.__paseoPostToDrawio = function(payload) {
  frame.contentWindow.postMessage(payload, 'https://embed.diagrams.net');
};
window.addEventListener('message', function(event) {
  if (event.origin === 'https://embed.diagrams.net') {
    window.ReactNativeWebView.postMessage(event.data);
  }
});
</script>
</body>
</html>`;
}

export function WorkspaceDrawioPreview({
  filePath,
  bytes,
  size,
  modifiedAt,
  onSave,
}: WorkspaceDrawioPreviewProps) {
  const { theme } = useUnistyles();
  const webViewRef = useRef<NativeWebView>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const xml = useMemo(() => bytesToUtf8(bytes), [bytes]);
  const title = useMemo(() => filePath.split("/").findLast(Boolean) ?? filePath, [filePath]);
  const html = useMemo(() => buildDrawioHtml(title), [title]);

  const postToDrawio = useCallback((payload: Record<string, unknown>) => {
    webViewRef.current?.injectJavaScript(
      `window.__paseoPostToDrawio(${escapeScriptString(JSON.stringify(payload))}); true;`,
    );
  }, []);

  const handleSavePress = useCallback(() => {
    postToDrawio({ action: "save" });
  }, [postToDrawio]);

  const webViewSource = useMemo(() => ({ html }), [html]);
  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(event.nativeEvent.data);
        payload =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        payload = null;
      }
      if (!payload) {
        return;
      }
      if (payload.event === "init") {
        postToDrawio({ action: "load", autosave: 0, title, xml });
        setStatus("ready");
        return;
      }
      if (payload.event !== "save" || typeof payload.xml !== "string") {
        return;
      }
      setStatus("saving");
      setError(null);
      void (async () => {
        try {
          await onSave({
            bytes: new TextEncoder().encode(payload.xml as string),
            expectedModifiedAt: modifiedAt,
            expectedSize: size,
          });
          setStatus("saved");
          postToDrawio({ action: "status", message: "Saved", modified: false });
        } catch (saveError) {
          setStatus("error");
          setError(saveError instanceof Error ? saveError.message : "Failed to save diagram");
          postToDrawio({ action: "status", message: "Save failed", modified: true });
        }
      })();
    },
    [modifiedAt, onSave, postToDrawio, size, title, xml],
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.statusSlot}>
          {status === "loading" || status === "saving" ? <ActivityIndicator size="small" /> : null}
          <Text style={styles.statusText} numberOfLines={1}>
            {error ?? (status === "saved" ? "Saved" : "Draw.io")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save diagram"
          onPress={handleSavePress}
          style={styles.saveButton}
        >
          <Save size={16} color={theme.colors.foreground} />
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      </View>
      <NativeWebView
        ref={webViewRef}
        originWhitelist={WEBVIEW_ORIGIN_WHITELIST}
        source={webViewSource}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  statusSlot: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  saveButton: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
  },
  saveButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  webview: {
    flex: 1,
  },
}));
