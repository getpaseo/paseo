import { useMemo } from "react";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";

export function FilePdfPreview({ uri, testID }: { uri: string; testID?: string }) {
  const source = useMemo(() => ({ uri }), [uri]);

  return (
    <WebView
      testID={testID}
      style={styles.webview}
      source={source}
      originWhitelist={["*"]}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
    />
  );
}

const styles = StyleSheet.create(() => ({
  webview: {
    flex: 1,
    backgroundColor: "white",
  },
}));
