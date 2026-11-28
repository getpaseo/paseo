import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagramColorScheme, MermaidRenderRequest } from "./render-model";
import { parseMermaidRuntimeMessage, type MermaidRuntimeRenderMessage } from "./runtime/messages";
import { MermaidRuntimeRequestDriver } from "./runtime/request-driver";

export interface MermaidRenderedMessage {
  revision: number;
  source: string;
  colorScheme: DiagramColorScheme;
  height: number;
  width: number;
}

interface MermaidIframeRuntimeProps {
  request: MermaidRenderRequest | null;
  onRendered: (message: MermaidRenderedMessage) => void;
  onRenderFailed: (revision: number) => void;
}

/** Sandboxed Mermaid renderer. Sizing and gestures belong to the surrounding viewport. */
export function MermaidIframeRuntime({
  request,
  onRendered,
  onRenderFailed,
}: MermaidIframeRuntimeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [runtimeHtml, setRuntimeHtml] = useState<string | null>();
  const driverRef = useRef<MermaidRuntimeRequestDriver | null>(null);
  driverRef.current ??= new MermaidRuntimeRequestDriver();

  const sendRequest = useCallback((current: MermaidRenderRequest | null) => {
    const target = iframeRef.current?.contentWindow;
    if (!current || !target) return;
    const message: MermaidRuntimeRenderMessage = {
      type: "render",
      revision: current.revision,
      source: current.source,
      colorScheme: current.colorScheme,
      interactive: false,
    };
    target.postMessage(message, "*");
  }, []);

  useEffect(() => {
    sendRequest(driverRef.current?.update(request) ?? null);
  }, [request, sendRequest]);

  useEffect(() => {
    let mounted = true;
    async function loadRuntime() {
      try {
        const { mermaidRuntimeHtml } = await import("./runtime/html.gen");
        if (mounted) setRuntimeHtml(mermaidRuntimeHtml);
      } catch {
        if (mounted) setRuntimeHtml(null);
      }
    }
    void loadRuntime();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (runtimeHtml === null && request) onRenderFailed(request.revision);
  }, [runtimeHtml, request, onRenderFailed]);

  useEffect(() => {
    function receiveMessage(event: MessageEvent): void {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message) return;
      if (message.type === "bridgeReady") {
        sendRequest(driverRef.current?.ready() ?? null);
        return;
      }
      if (message.type === "renderError") {
        onRenderFailed(message.revision);
        sendRequest(driverRef.current?.settled(message.revision, false) ?? null);
        return;
      }
      onRendered(message);
      sendRequest(driverRef.current?.settled(message.revision, true) ?? null);
    }
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [onRenderFailed, onRendered, sendRequest]);

  if (!runtimeHtml) return null;

  // `inert` (not just tabIndex) because the Modal focus trap focuses descendants
  // programmatically; a focused iframe swallows every keystroke, including Escape.
  return (
    <iframe
      ref={iframeRef}
      title=""
      aria-hidden
      inert
      sandbox="allow-scripts"
      srcDoc={runtimeHtml}
      tabIndex={-1}
      style={iframeStyle}
    />
  );
}

const iframeStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  border: 0,
  pointerEvents: "none",
  background: "transparent",
};
