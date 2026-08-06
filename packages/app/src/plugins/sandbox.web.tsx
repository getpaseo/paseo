import { useCallback, useEffect, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { createInitMessage, createUpdateMessage, type PluginSandboxProps } from "./bridge";
import { attachPluginBridge, createPluginIframe, postToPluginIframe } from "./frame.web";
import { resolvePluginThemeTokens, type ThemedPluginSandboxProps } from "./theme";
import { PLUGIN_READY_TIMEOUT_MS, PluginReadyTimeout } from "./sandbox-error";

function PluginSandboxView({
  html,
  context,
  onOpenFile,
  testID,
  themeTokens,
}: ThemedPluginSandboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const [handshake, setHandshake] = useState<"waiting" | "ready" | "timeout">("waiting");
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ context, onOpenFile, themeTokens });

  useEffect(() => {
    latest.current = { context, onOpenFile, themeTokens };
  }, [context, onOpenFile, themeTokens]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const iframe = createPluginIframe(html);
    frameRef.current = iframe;
    readyRef.current = false;
    const detach = attachPluginBridge(iframe, {
      onReady: () => {
        readyRef.current = true;
        setHandshake("ready");
        postToPluginIframe(
          iframe,
          createInitMessage(latest.current.context, latest.current.themeTokens),
        );
      },
      onOpenFile: (input) => latest.current.onOpenFile?.(input),
    });
    container.appendChild(iframe);
    return () => {
      detach();
      iframe.remove();
      frameRef.current = null;
      readyRef.current = false;
    };
  }, [html, attempt]);

  useEffect(() => {
    if (handshake !== "waiting") {
      return;
    }
    const timer = setTimeout(() => setHandshake("timeout"), PLUGIN_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [handshake, attempt]);

  useEffect(() => {
    setHandshake("waiting");
  }, [html]);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !readyRef.current) {
      return;
    }
    postToPluginIframe(iframe, createUpdateMessage(context, themeTokens));
  }, [context, themeTokens]);

  const handleRetry = useCallback(() => {
    readyRef.current = false;
    setHandshake("waiting");
    setAttempt((current) => current + 1);
  }, []);

  if (handshake === "timeout") {
    return <PluginReadyTimeout onRetry={handleRetry} testID={testID} />;
  }

  return <div ref={containerRef} data-testid={testID} style={CONTAINER_STYLE} />;
}

/**
 * The theme reaches the plugin as a prop rather than a hook so a theme switch
 * re-renders this subtree. `useUnistyles()` would do it too and is banned
 * (docs/unistyles.md).
 */
export const PluginSandbox = withUnistyles(PluginSandboxView, (theme) => ({
  themeTokens: resolvePluginThemeTokens(theme),
})) as (props: PluginSandboxProps) => React.ReactElement;

const CONTAINER_STYLE = {
  display: "flex",
  flex: "1 1 auto",
  minHeight: 0,
  overflow: "hidden",
} as const;
