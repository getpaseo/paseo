import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { withPreviewCsp } from "./html-preview-csp";
import { PREVIEW_SCROLL_MARKER, withPreviewScrollBridge } from "./html-preview-scroll";
import { readPreviewScroll, writePreviewScroll } from "./preview-scroll-memory";

// `allow-scripts` alone: the file gets an opaque origin, so a plan page can run
// its own scripts (Excalidraw, charts) but cannot reach the Paseo app's DOM,
// cookies, or storage, and cannot navigate the top window. Agent-written HTML is
// not trusted markup. No popup tokens — a preview is a viewer, not a browser, and
// escaping the sandbox to open one buys nothing for reading a local plan. The same
// isolation means storage APIs throw inside the frame; pages that want to persist
// state have to export.
//
// A sandboxed frame may still navigate *itself*, and nothing in CSP stops that
// (see html-preview-csp.ts). That is the one hole left on web, it is bounded to
// the page's own contents, and it is documented in SECURITY.md rather than papered
// over with a directive browsers ignore.
const SANDBOX = "allow-scripts";

const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

interface BridgeMessage {
  y: number;
}

function bridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message[PREVIEW_SCROLL_MARKER] !== "ask" && message[PREVIEW_SCROLL_MARKER] !== "pos") {
    return null;
  }
  return typeof message.y === "number" ? { y: message.y } : null;
}

/**
 * Makes the browser composite this frame again.
 *
 * A preview that was hidden and shown again keeps its scroll offset but is composited
 * from the snapshot taken before it went away: the page looks like it went back to the
 * top until something forces a fresh frame, and scrolling it by a pixel is enough. The
 * toggle costs one repaint, and it is repeated because the first one can land before
 * the frame is back on screen.
 */
const REPAINT_DELAYS = [0, 120, 400, 900, 1600];

function repaint(frame: HTMLIFrameElement): void {
  for (const delay of REPAINT_DELAYS) {
    setTimeout(() => {
      if (!frame.isConnected) return;
      frame.style.opacity = "0.999";
      requestAnimationFrame(() => {
        frame.style.opacity = "";
      });
    }, delay);
  }
}

export function FileHtmlPreview({
  html,
  testID,
  scrollKey,
}: {
  html: string;
  testID?: string;
  /** Where this tab's scroll offset is remembered; omit it to keep the frame stateless. */
  scrollKey?: string;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // A document URL lets the browser resolve fragment links within the preview.
  // srcDoc would inherit the app URL and navigate the frame back into Paseo.
  const source = useMemo(
    () =>
      `data:text/html;charset=utf-8,${encodeURIComponent(withPreviewScrollBridge(withPreviewCsp(html)))}`,
    [html],
  );

  const postRestore = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !scrollKey) return;
    const offset = readPreviewScroll(scrollKey);
    if (offset <= 0) return;
    // The frame is usually still settling when it asks: the document has not finished
    // laying out, so a single restore can be applied before there is height to scroll
    // to. The message is idempotent, so it is repeated alongside the repaints.
    for (const delay of REPAINT_DELAYS) {
      setTimeout(() => {
        try {
          frame.contentWindow?.postMessage({ [PREVIEW_SCROLL_MARKER]: "restore", y: offset }, "*");
        } catch {
          return;
        }
      }, delay);
    }
    repaint(frame);
  }, [scrollKey]);

  useEffect(() => {
    if (!scrollKey) return;
    const handleMessage = (event: MessageEvent) => {
      const message = bridgeMessage(event.data);
      if (!message) return;
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (frameWindowAsks(event.data)) postRestore();
      else writePreviewScroll(scrollKey, message.y);
    };
    const handleVisible = () => {
      if (document.visibilityState === "visible") postRestore();
    };
    window.addEventListener("message", handleMessage);
    window.addEventListener("focus", postRestore);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("focus", postRestore);
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [postRestore, scrollKey]);

  return (
    <iframe
      ref={frameRef}
      data-testid={testID}
      title={t("panels.file.filePanels.builtin.html")}
      src={source}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}

function frameWindowAsks(data: unknown): boolean {
  return Boolean(
    data &&
    typeof data === "object" &&
    (data as Record<string, unknown>)[PREVIEW_SCROLL_MARKER] === "ask",
  );
}
