import { useCallback, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { pdfRuntimeHtml } from "./runtime/html.gen";
import { pdfViewInput } from "./config";
import type { PdfViewProps } from "./view.types";
const style = { flex: 1, minHeight: 0 };
const origins = ["about:blank", "file://*"];
export function PdfView({ uri }: PdfViewProps) {
  const ref = useRef<WebView>(null);
  const source = useMemo(
    () => ({ html: pdfRuntimeHtml, baseUrl: uri.slice(0, uri.lastIndexOf("/") + 1) }),
    [uri],
  );
  const load = useCallback(
    () =>
      ref.current?.injectJavaScript(
        `window.PaseoPdf.open(${JSON.stringify(pdfViewInput(uri))}); true;`,
      ),
    [uri],
  );
  const allowNavigation = useCallback(
    (request: { url: string }) => request.url === "about:blank" || request.url === source.baseUrl,
    [source],
  );
  return (
    <WebView
      key={uri}
      ref={ref}
      source={source}
      onLoadEnd={load}
      style={style}
      originWhitelist={origins}
      onShouldStartLoadWithRequest={allowNavigation}
      allowFileAccess
      allowFileAccessFromFileURLs
      javaScriptEnabled
      setSupportMultipleWindows={false}
      testID="pdf-reader"
    />
  );
}
