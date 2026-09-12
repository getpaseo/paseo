import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebViewMessageEvent } from "react-native-webview";
import { WebView } from "react-native-webview";
import { StyleSheet } from "react-native-unistyles";
import { SourceEditorController } from "./controller";
import type { SourceEditorConfiguration, SourceEditorProps } from "./contract";
import {
  parseSourceEditorBridgeMessage,
  type SourceEditorHostMessage,
} from "./codemirror/bridge-protocol";
import { sourceEditorWebViewHtml } from "./codemirror/webview-html";

const BASE_URL = "about:blank";
const ORIGIN_WHITELIST = ["*"];
let nextEditorKey = 1;

export function SourceEditor(props: SourceEditorProps) {
  const webViewRef = useRef<WebView>(null);
  const bridgeReadyRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [editorKey] = useState(() => `native-source-editor-${nextEditorKey++}`);
  const controllerRef = useRef<SourceEditorController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SourceEditorController({
      editorKey,
      document: props.document,
      callbacks: {
        onChange: (document) => propsRef.current.onChange(document),
        onSave: () => propsRef.current.onSave(),
        onCursorChange: (position) => propsRef.current.onCursorChange(position),
        onVimModeChange: (mode) => propsRef.current.onVimModeChange(mode),
      },
    });
  }
  const controller = controllerRef.current;
  const source = useMemo(() => ({ html: sourceEditorWebViewHtml, baseUrl: BASE_URL }), []);
  const configuration = useMemo<SourceEditorConfiguration>(
    () => ({ filename: props.filename, vimEnabled: props.vimEnabled, theme: props.theme }),
    [props.filename, props.theme, props.vimEnabled],
  );

  const send = useCallback((message: SourceEditorHostMessage) => {
    if (!bridgeReadyRef.current) return;
    const serialized = JSON.stringify(JSON.stringify(message));
    webViewRef.current?.injectJavaScript(
      `window.__PASEO_SOURCE_EDITOR_RECEIVE__?.(${serialized}); true;`,
    );
  }, []);

  const mount = useCallback(() => {
    send({
      type: "mount",
      editorKey,
      document: controller.getRuntimeDocument(),
      configuration: configurationFromProps(propsRef.current),
    });
  }, [controller, editorKey, send]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseSourceEditorBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "bridgeReady") {
        bridgeReadyRef.current = true;
        mount();
        const selectionTarget = propsRef.current.selectionTarget;
        if (selectionTarget) send({ type: "reveal", editorKey, ...selectionTarget });
        return;
      }
      controller.receive(message);
    },
    [controller, editorKey, mount, send],
  );

  useEffect(() => {
    const replacement = controller.replaceDocument(props.document);
    if (replacement !== null) {
      send({ type: "replaceDocument", editorKey, document: replacement });
    }
  }, [controller, editorKey, props.document, send]);

  useEffect(() => {
    send({
      type: "configure",
      editorKey,
      configuration,
    });
  }, [configuration, editorKey, send]);

  useEffect(() => {
    if (props.selectionTarget) {
      send({ type: "reveal", editorKey, ...props.selectionTarget });
    }
  }, [editorKey, props.selectionTarget, send]);

  useEffect(
    () => () => {
      send({ type: "destroy", editorKey });
      bridgeReadyRef.current = false;
    },
    [editorKey, send],
  );

  const allowOnlyInitialDocument = useCallback(({ url }: { url: string }) => {
    return url === BASE_URL;
  }, []);

  const reloadAfterProcessFailure = useCallback(() => {
    bridgeReadyRef.current = false;
    webViewRef.current?.reload();
  }, []);
  const handleLoadStart = useCallback(() => {
    bridgeReadyRef.current = false;
  }, []);
  const handleRenderProcessGone = useCallback(() => {
    reloadAfterProcessFailure();
    return true;
  }, [reloadAfterProcessFailure]);

  return (
    <WebView
      ref={webViewRef}
      testID="file-source-editor"
      style={[styles.webview, { backgroundColor: props.theme.background }]}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowOnlyInitialDocument}
      onMessage={handleMessage}
      onLoadStart={handleLoadStart}
      onContentProcessDidTerminate={reloadAfterProcessFailure}
      onRenderProcessGone={handleRenderProcessGone}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
      scrollEnabled={false}
      overScrollMode="never"
      keyboardDisplayRequiresUserAction={false}
    />
  );
}

function configurationFromProps(props: SourceEditorProps): SourceEditorConfiguration {
  return { filename: props.filename, vimEnabled: props.vimEnabled, theme: props.theme };
}

const styles = StyleSheet.create(() => ({
  webview: { flex: 1 },
}));
