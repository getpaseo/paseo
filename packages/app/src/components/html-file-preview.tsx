import { useMemo, type ComponentProps } from "react";
import * as Linking from "expo-linking";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";

const ORIGIN_WHITELIST = ["*"];

// Navigation policy for the previewed content. The injected HTML loads with an
// empty baseUrl, so the document and all in-page navigation live on
// `about:blank`:
//   - the initial load and in-page anchor / fragment jumps (`#section`) stay on
//     about:blank → allowed, so in-page links work.
//   - external links (http/https/mailto/…) are opened in the system browser
//     instead of letting the preview navigate the WebView pane away to an
//     external page (which would break the sandboxed-preview guarantee).
// Hoisted to module scope so it's a stable prop reference.
const handleWebViewNavigation: NonNullable<
  ComponentProps<typeof WebView>["onShouldStartLoadWithRequest"]
> = (request) => {
  const url = request.url;
  if (url === "" || url.startsWith("about:blank") || url.startsWith("#")) {
    return true;
  }
  void Linking.openURL(url).catch(() => {
    // Ignore: nothing to do if the OS can't open the URL.
  });
  return false;
};

/**
 * Native (iOS / Android) HTML preview. Renders the file content inside a
 * react-native-webview, which is an isolated web context separate from the app
 * (the analog of the sandboxed iframe used on web in html-file-preview.web.tsx).
 * `setSupportMultipleWindows={false}` blocks `window.open()` popups, and
 * `onShouldStartLoadWithRequest` blocks any in-place navigation triggered by
 * the previewed content (links, `meta refresh`, JS `location` changes) so the
 * preview cannot navigate the pane away to an external URL.
 */
export function HtmlFilePreview({ content }: { content: string }) {
  const source = useMemo(() => ({ html: content, baseUrl: "" }), [content]);
  return (
    <WebView
      originWhitelist={ORIGIN_WHITELIST}
      source={source}
      style={styles.webview}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={handleWebViewNavigation}
      // Keep horizontal layout sane for documents authored for desktop widths.
      scalesPageToFit
    />
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
});
