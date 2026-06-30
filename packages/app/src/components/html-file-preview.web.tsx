import { createElement, useCallback, useEffect, useRef, type CSSProperties } from "react";

const IFRAME_STYLE: CSSProperties = {
  border: "none",
  width: "100%",
  height: "100%",
  backgroundColor: "#ffffff",
};

/**
 * Renders HTML file content live in a sandboxed iframe.
 *
 * Security: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the
 * frame a unique opaque origin — scripts can run (so the preview stays
 * interactive: buttons, JS, in-page `#anchor` jumps all work) but they cannot
 * reach the parent app, its DOM, cookies, or storage.
 *
 * Navigation guard (web equivalent of the native renderer's
 * `onShouldStartLoadWithRequest`): a sandboxed iframe can still navigate its OWN
 * browsing context, so a preview document doing `location.href = …`, a
 * `meta refresh`, or a plain link click could otherwise replace the pane with an
 * arbitrary external page. We allow only the initial `srcDoc` load; any
 * subsequent top-level load means the preview tried to navigate away, so we
 * restore the original content. In-page fragment navigation does NOT trigger a
 * `load` event, so anchor links and interactivity are preserved.
 *
 * `createElement` is used (as in browser-pane.electron.tsx) so the DOM element
 * typechecks cleanly inside this React Native + react-native-web project.
 */
export function HtmlFilePreview({ content }: { content: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialLoadDoneRef = useRef(false);

  // Treat the load triggered by a new file's content as a fresh initial load.
  useEffect(() => {
    initialLoadDoneRef.current = false;
  }, [content]);

  const handleLoad = useCallback(() => {
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      return;
    }
    // A full navigation happened after the initial render — snap the preview
    // back to its own content so it can't be hijacked to an external page.
    // The restore re-loads `srcDoc`, which counts as the next "initial" load.
    initialLoadDoneRef.current = false;
    const frame = frameRef.current;
    if (frame) {
      frame.srcdoc = content;
    }
  }, [content]);

  return createElement("iframe", {
    ref: frameRef,
    title: "HTML preview",
    srcDoc: content,
    sandbox: "allow-scripts",
    onLoad: handleLoad,
    style: IFRAME_STYLE,
  });
}
