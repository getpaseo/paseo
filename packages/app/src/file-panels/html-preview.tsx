import { useMemo } from "react";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";
import { withPreviewCsp } from "./html-preview-csp";
import { useHtmlPreviewNavigationGuard } from "./html-preview-navigation";

// A preview is a viewer, not a browser. Only the document Paseo hands the WebView
// loads; navigations the page attempts afterwards are refused, so a link, a
// `location.href` assignment, or a meta refresh cannot pull a remote page into the
// pane or leak the file through a URL. Storage and cache stay off so a page leaves
// nothing behind between opens.
//
// This guard is not absolute, and SECURITY.md says so rather than implying
// otherwise: the decision runs in app JS, and Android's WebView allows a
// navigation whose decision doesn't return in time. A stalled JS thread is
// therefore a window, which is why the CSP does the load-bearing work and this
// guard narrows what's left.
//
// `originWhitelist: ["*"]` is what makes that guarantee hold. react-native-webview
// checks the whitelist *before* calling onShouldStartLoadWithRequest and hands
// anything that fails it to `Linking.openURL` — so a narrow whitelist would route
// custom schemes straight to the system browser without this guard ever seeing
// them. Matching everything forces every scheme through the callback below.
const ORIGIN_WHITELIST = ["*"];

// Pinning the base URL is what makes the guard below sound. Android loads
// `source={{ html }}` through `loadDataWithBaseURL`, and a programmatic load is not
// reliably reported to onShouldStartLoadWithRequest — so the latch may still be
// unset when the page makes its first move. Naming an inert base means the only
// URLs that can pass as "initial" are inert ones. `data:text/html` must NOT be
// allowed here: a page could navigate itself to a data document of its own, which
// would arrive with no injected policy and a clean slate to egress from.
const BASE_URL = "about:blank";

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  const document = useMemo(() => withPreviewCsp(html), [html]);
  const source = useMemo(() => ({ html: document, baseUrl: BASE_URL }), [document]);
  const allowOnlyInitialDocument = useHtmlPreviewNavigationGuard(document);

  return (
    <WebView
      testID={testID}
      style={styles.webview}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowOnlyInitialDocument}
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
