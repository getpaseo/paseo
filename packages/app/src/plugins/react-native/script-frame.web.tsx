import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ScriptFrameHandle, ScriptFrameProps } from "@getpaseo/plugin/client/ui";
import {
  createPostQueue,
  parsePageMessage,
  routePageMessage,
  scriptFrameHtml,
} from "./script-frame-page";

const frameStyle = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  height: "100%",
  border: "none",
  backgroundColor: "transparent",
} as const;

/**
 * An iframe with `sandbox="allow-scripts"` and no same origin with Paseo, so the page has no
 * storage (`localStorage` throws) and cannot reach Paseo's page. Messages cross by `postMessage`,
 * and only those from this frame's own window are heard.
 */
export const ScriptFrame = forwardRef<ScriptFrameHandle, ScriptFrameProps>(function ScriptFrame(
  { script, onMessage, onError, title, testID },
  ref,
) {
  const element = useRef<HTMLIFrameElement | null>(null);
  // (state, not a memo: a caller may keep the first handle's `post` for the frame's life)
  const [queue] = useState(() =>
    createPostQueue((text) =>
      element.current?.contentWindow?.postMessage({ paseoFrame: "call", text }, "*"),
    ),
  );
  const html = useMemo(() => scriptFrameHtml(script, "web"), [script]);
  const handlers = useRef({ onMessage, onError });
  useEffect(() => {
    handlers.current = { onMessage, onError };
  });
  useEffect(() => {
    queue.reset();
  }, [html, queue]);
  useImperativeHandle(ref, () => ({ post: queue.post }), [queue]);

  useEffect(() => {
    function onWindowMessage(event: MessageEvent) {
      const frame = element.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parsePageMessage(event.data);
      if (message === null) return;
      routePageMessage(message, queue, {
        onMessage: (text) => handlers.current.onMessage(text),
        onError: (text) => handlers.current.onError?.(text),
      });
    }
    window.addEventListener("message", onWindowMessage);
    return () => window.removeEventListener("message", onWindowMessage);
  }, [queue]);

  return (
    <iframe
      ref={element}
      title={title}
      data-testid={testID}
      srcDoc={html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={frameStyle}
    />
  );
});
