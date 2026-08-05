import { useEffect, useRef } from "react";
import {
  createInitMessage,
  createUpdateMessage,
  type PluginContext,
  type PluginSandboxProps,
} from "./bridge";
import { attachPluginBridge, createPluginIframe, postToPluginIframe } from "./frame.web";
import { resolvePluginThemeTokens } from "./theme";

export function PluginSandbox({ html, context, onOpenFile, onResize, testID }: PluginSandboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const latest = useRef({ context, onOpenFile, onResize });

  useEffect(() => {
    latest.current = { context, onOpenFile, onResize };
  }, [context, onOpenFile, onResize]);

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
        postToPluginIframe(
          iframe,
          createInitMessage(latest.current.context, resolvePluginThemeTokens()),
        );
      },
      onOpenFile: (input) => latest.current.onOpenFile?.(input),
      onResize: (height) => latest.current.onResize?.(height),
    });
    container.appendChild(iframe);
    return () => {
      detach();
      iframe.remove();
      frameRef.current = null;
      readyRef.current = false;
    };
  }, [html]);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !readyRef.current) {
      return;
    }
    postToPluginIframe(iframe, createUpdateMessage(context));
  }, [context]);

  return <div ref={containerRef} data-testid={testID} style={CONTAINER_STYLE} />;
}

const CONTAINER_STYLE = {
  display: "flex",
  flex: "1 1 auto",
  minHeight: 0,
  overflow: "hidden",
} as const;

export type { PluginContext, PluginSandboxProps };
