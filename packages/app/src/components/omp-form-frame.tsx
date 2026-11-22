import { useCallback, useMemo, useState } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { htmlPreviewNavigationKind } from "@/file-panels/html-preview-navigation";
import { parseOmpFormMessage, type OmpFormMessage } from "./omp-form-document";

export interface OmpFormFrameProps {
  document: string;
  title: string;
  onAnswer: (message: Exclude<OmpFormMessage, { height: number }>) => void;
}

const originWhitelist = ["*"];

function allowDocument({ url }: { url: string }): boolean {
  return htmlPreviewNavigationKind(url) === "initialDocument";
}

export function OmpFormFrame({ document, title, onAnswer }: OmpFormFrameProps) {
  const [height, setHeight] = useState(120);
  const source = useMemo(() => ({ html: document, baseUrl: "about:blank" }), [document]);
  const containerStyle = useMemo(() => ({ height, flex: 0 }), [height]);
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseOmpFormMessage(event.nativeEvent.data);
      if (!message) return;
      if ("height" in message) setHeight(message.height);
      else onAnswer(message);
    },
    [onAnswer],
  );

  return (
    <WebView
      accessibilityLabel={title}
      containerStyle={containerStyle}
      source={source}
      originWhitelist={originWhitelist}
      onShouldStartLoadWithRequest={allowDocument}
      onMessage={onMessage}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
    />
  );
}
