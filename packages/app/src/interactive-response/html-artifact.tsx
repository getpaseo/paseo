import type { HtmlArtifactProps } from "./artifact";
import { useCallback, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useArtifact, type ArtifactCommand } from "./use-artifact";
import { styles } from "./styles";
const FRAME_STYLE = { height: 360 };
const ORIGINS = ["about:blank"];
function allowNavigation(request: { url: string }) {
  return request.url === "about:blank";
}
export function HtmlArtifact({ html, name, colorScheme = "light" }: HtmlArtifactProps) {
  const { t } = useTranslation();
  const frame = useRef<WebView>(null);
  const post = useCallback((command: ArtifactCommand) => {
    frame.current?.injectJavaScript(
      `window.__PASEO_ARTIFACT_RECEIVE__?.(${JSON.stringify(command)});true;`,
    );
  }, []);
  const runtime = useArtifact({ html, name, post, colorScheme });
  const source = useMemo(() => ({ html: runtime.source }), [runtime.source]);
  const { receive, fail } = runtime;
  const message = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      try {
        receive(JSON.parse(event.nativeEvent.data));
      } catch {
        fail();
      }
    },
    [receive, fail],
  );
  if (!runtime.mounted) return null;
  return (
    <View style={styles.content}>
      {runtime.status === "loading" ? (
        <Text style={styles.muted}>{t("interactive.loading")}</Text>
      ) : null}
      {runtime.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("interactive.renderError")}
        </Text>
      ) : null}
      {runtime.status !== "error" ? (
        <WebView
          key={runtime.revision}
          ref={frame}
          source={source}
          style={FRAME_STYLE}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          mixedContentMode="never"
          originWhitelist={ORIGINS}
          onShouldStartLoadWithRequest={allowNavigation}
          onError={fail}
          onMessage={message}
          setSupportMultipleWindows={false}
        />
      ) : null}
      <Button size="sm" variant="ghost" onPress={runtime.reload}>
        {t("interactive.reload")}
      </Button>
    </View>
  );
}
