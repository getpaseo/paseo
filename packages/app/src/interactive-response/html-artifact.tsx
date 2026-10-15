import { useMemo, useState, useCallback } from "react";
import { Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { inertArtifactHtml } from "./html-policy";
import { styles } from "./styles";
const FRAME_STYLE = { height: 360 };
const ORIGINS = ["about:blank"];
function allowNavigation(request: { url: string }) {
  return request.url === "about:blank";
}
export function HtmlArtifact({ html }: { html: string }) {
  const { t } = useTranslation();
  const safe = useMemo(() => inertArtifactHtml(html), [html]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  const source = useMemo(() => ({ html: safe.html }), [safe.html]);
  const failed = useCallback(() => setError(true), []);
  const reload = useCallback(() => {
    setError(false);
    setRevision((value) => value + 1);
  }, []);
  return (
    <View style={styles.content}>
      {safe.scripted ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("interactive.scriptBlocked")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("interactive.renderError")}
        </Text>
      ) : null}
      <WebView
        key={revision}
        source={source}
        style={FRAME_STYLE}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        mixedContentMode="never"
        originWhitelist={ORIGINS}
        onShouldStartLoadWithRequest={allowNavigation}
        onError={failed}
        setSupportMultipleWindows={false}
      />
      <Button size="sm" variant="ghost" onPress={reload}>
        {t("interactive.reload")}
      </Button>
    </View>
  );
}
