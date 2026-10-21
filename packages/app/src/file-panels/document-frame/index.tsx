import { useCallback, useMemo, useRef } from "react";
import { Platform, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

const frameStyle = { flex: 1, backgroundColor: "white" };
const originWhitelist = ["*"];

/** What Android's WebView shows inline. It has no viewer for PDF or other documents. */
const ANDROID_INLINE_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "xml",
  "svg",
  "txt",
  "json",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
]);

export function DocumentFrame({ url, testID }: { url: string; testID?: string }) {
  const source = useMemo(() => ({ uri: url }), [url]);
  const loaded = useRef<string | null>(null);
  const allowDocument = useCallback(
    (request: { url: string }) => {
      if (!url.startsWith("file:") || request.url !== url || loaded.current === url) return false;
      loaded.current = url;
      return true;
    },
    [url],
  );
  if (!url.startsWith("file:")) return null;
  // The host names a file URL after the file, so its extension is the document's type.
  const extension = urlExtension(url);
  if (Platform.OS === "android" && !ANDROID_INLINE_EXTENSIONS.has(extension)) {
    return <UnsupportedDocument extension={extension} testID={testID} />;
  }
  return (
    <WebView
      testID={testID}
      style={frameStyle}
      source={source}
      originWhitelist={originWhitelist}
      onShouldStartLoadWithRequest={allowDocument}
      javaScriptEnabled={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
      allowFileAccess
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowingReadAccessToURL={url}
    />
  );
}

function UnsupportedDocument({ extension, testID }: { extension: string; testID?: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={styles.mutedText}>
        {t("panels.file.documentUnsupported", { type: extension.toUpperCase() })}
      </Text>
    </View>
  );
}

function urlExtension(url: string): string {
  const path = url.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
