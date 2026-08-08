import { useCallback, useEffect, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { createInitMessage, createUpdateMessage, type PluginSandboxProps } from "./bridge";
import { attachPluginBridge, createPluginIframe, postToPluginIframe } from "./frame.web";
import {
  resolvePluginThemeTokens,
  useStableThemeTokens,
  type ThemedPluginSandboxProps,
} from "./theme";
import { PLUGIN_READY_TIMEOUT_MS, PluginReadyTimeout } from "./sandbox-error";

function PluginSandboxView({
  html,
  context,
  onOpenFile,
  testID,
  themeTokens: rawThemeTokens,
}: ThemedPluginSandboxProps) {
  const themeTokens = useStableThemeTokens(rawThemeTokens);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const [handshake, setHandshake] = useState<"waiting" | "ready" | "timeout">("waiting");
  const [attempt, setAttempt] = useState(0);
  // Reset during render, not in an effect: an effect resets one commit late, so
  // a plugin swapped in while a panel is open would show the previous plugin's
  // outcome for a frame.
  const [renderedHtml, setRenderedHtml] = useState(html);
  if (renderedHtml !== html) {
    setRenderedHtml(html);
    setHandshake("waiting");
  }
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
  }, [handshake, attempt, html]);

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

  return (
    <div data-testid={testID} style={CONTAINER_STYLE}>
      {/*
        The frame's container stays mounted through a timeout instead of being
        swapped for the card. The frame is appended imperatively, so unmounting
        the container nulls the ref — and then a plugin that times out and whose
        `html` later changes gets a mount effect that finds no container, bails,
        and never runs again, because `html` is the dep it would have re-fired
        on. Permanently blank pane, nothing to retry.
      */}
      <div ref={containerRef} style={handshake === "timeout" ? HIDDEN_STYLE : CONTAINER_STYLE} />
      {handshake === "timeout" ? <PluginReadyTimeout onRetry={handleRetry} /> : null}
    </div>
  );
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

const HIDDEN_STYLE = { display: "none" } as const;
